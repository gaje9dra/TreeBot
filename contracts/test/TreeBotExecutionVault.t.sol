// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "../src/TreeBotExecutionVault.sol";

interface Vm {
    function prank(address) external;
    function expectRevert(bytes calldata) external;
    function warp(uint256) external;
    function chainId(uint256) external;
}

contract MockToken {
    string public name;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    constructor(string memory n) { name = n; }
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "BALANCE");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "ALLOWANCE");
        require(balanceOf[from] >= amount, "BALANCE");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockSwapTarget {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, address recipient) external {
        require(MockToken(tokenIn).transferFrom(msg.sender, address(this), amountIn), "INPUT_TRANSFER");
        require(MockToken(tokenOut).transfer(recipient, amountOut), "OUTPUT_TRANSFER");
    }

    function swapOutputTo(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, address recipient) external {
        require(MockToken(tokenIn).transferFrom(msg.sender, address(this), amountIn), "INPUT_TRANSFER");
        require(MockToken(tokenOut).transfer(recipient, amountOut), "OUTPUT_TRANSFER");
    }
}

contract TreeBotExecutionVaultTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant START_TIME = 1_800_000_000;
    address private constant EXECUTOR = address(0xB07);
    TreeBotExecutionVault private vault;
    MockToken private tokenIn;
    MockToken private tokenOut;
    MockSwapTarget private target;

    function setUp() public {
        vm.chainId(137);
        vm.warp(START_TIME);
        vault = new TreeBotExecutionVault();
        tokenIn = new MockToken("Input");
        tokenOut = new MockToken("Output");
        target = new MockSwapTarget();

        vault.setTokenPolicy(address(tokenIn), true, 1_000, 2_500);
        vault.setTokenPolicy(address(tokenOut), true, 10_000, 25_000);
        vault.setPairAllowed(address(tokenIn), address(tokenOut), true);
        // Both mock tokens use identical units; owner requires at least 0.1 output base units per input base unit.
        vault.setPairMinimumOutputRate(address(tokenIn), address(tokenOut), 1, 10);
        vault.setTargetAllowed(address(target), true);
        vault.setSpenderAllowed(address(target), true);
        vault.authorizeExecutor(EXECUTOR, uint64(START_TIME + 30 days));
        vault.setEmergencyStop(false);

        tokenIn.mint(address(this), 20_000);
        tokenIn.approve(address(vault), 20_000);
        vault.deposit(address(tokenIn), 20_000);
        tokenOut.mint(address(target), 100_000);
    }

    function _execute(bytes32 intent, uint256 amountIn, uint256 minOut, uint256 actualOut) private returns (uint256) {
        bytes memory data = abi.encodeCall(
            MockSwapTarget.swap,
            (address(tokenIn), address(tokenOut), amountIn, actualOut, address(vault))
        );
        vm.prank(EXECUTOR);
        return vault.executeSwap(intent, address(tokenIn), address(tokenOut), amountIn, minOut,
            address(target), address(target), data, uint64(block.timestamp + 1 hours));
    }

    function testDepositAndSuccessfulSwapUsesRealContractState() public {
        uint256 beforeIn = vault.balanceOf(address(tokenIn));
        uint256 out = _execute(bytes32(uint256(1)), 100, 190, 195);
        require(out == 195, "ACTUAL_OUTPUT");
        require(vault.balanceOf(address(tokenIn)) == beforeIn - 100, "INPUT_BALANCE");
        require(vault.balanceOf(address(tokenOut)) == 195, "OUTPUT_BALANCE");
        require(tokenIn.allowance(address(vault), address(target)) == 0, "ALLOWANCE_NOT_CLEARED");
        require(vault.usedIntent(bytes32(uint256(1))), "INTENT_NOT_RECORDED");
    }

    function testRejectsDuplicateIntent() public {
        _execute(bytes32(uint256(2)), 100, 190, 195);
        vm.expectRevert(abi.encodeWithSelector(TreeBotExecutionVault.IntentAlreadyUsed.selector));
        _execute(bytes32(uint256(2)), 100, 190, 195);
    }

    function testRejectsOutputBelowMinimumAndRollsBack() public {
        uint256 beforeIn = vault.balanceOf(address(tokenIn));
        vm.expectRevert(abi.encodeWithSelector(TreeBotExecutionVault.MinimumOutputNotMet.selector));
        _execute(bytes32(uint256(3)), 100, 200, 199);
        require(vault.balanceOf(address(tokenIn)) == beforeIn, "INPUT_NOT_ROLLED_BACK");
        require(!vault.usedIntent(bytes32(uint256(3))), "FAILED_INTENT_SHOULD_ROLL_BACK");
        require(tokenIn.allowance(address(vault), address(target)) == 0, "ALLOWANCE_NOT_ROLLED_BACK");
    }

    function testExecutorCannotLowerOwnerMinimumPairRatePerTrade() public {
        uint256 beforeIn = vault.balanceOf(address(tokenIn));
        vm.expectRevert(abi.encodeWithSelector(TreeBotExecutionVault.PairMinimumRateNotMet.selector));
        _execute(bytes32(uint256(14)), 100, 1, 5);
        require(vault.balanceOf(address(tokenIn)) == beforeIn, "INPUT_NOT_ROLLED_BACK");
        require(!vault.usedIntent(bytes32(uint256(14))), "FAILED_INTENT_SHOULD_ROLL_BACK");
    }

    function testRejectsPayloadThatSpendsLessThanApprovedIntent() public {
        bytes memory data = abi.encodeCall(
            MockSwapTarget.swap,
            (address(tokenIn), address(tokenOut), uint256(99), uint256(195), address(vault))
        );
        vm.prank(EXECUTOR);
        vm.expectRevert(abi.encodeWithSelector(TreeBotExecutionVault.InputDeltaMismatch.selector));
        vault.executeSwap(bytes32(uint256(4)), address(tokenIn), address(tokenOut), 100, 190,
            address(target), address(target), data, uint64(block.timestamp + 1 hours));
    }

    function testEmergencyStopRejectsNewSwapsButAllowsOwnerWithdrawal() public {
        vault.setEmergencyStop(true);
        vm.prank(EXECUTOR);
        vm.expectRevert(abi.encodeWithSelector(TreeBotExecutionVault.EmergencyStopActive.selector));
        vault.executeSwap(bytes32(uint256(5)), address(tokenIn), address(tokenOut), 100, 190,
            address(target), address(target),
            abi.encodeCall(MockSwapTarget.swap, (address(tokenIn), address(tokenOut), uint256(100), uint256(195), address(vault))),
            uint64(block.timestamp + 1 hours));
        uint256 before = tokenIn.balanceOf(address(this));
        vault.withdraw(address(tokenIn), address(this), 500);
        require(tokenIn.balanceOf(address(this)) == before + 500, "WITHDRAWAL_BLOCKED_BY_PAUSE");
    }

    function testPerTradeCapRejectsOversizedSwap() public {
        vm.prank(EXECUTOR);
        vm.expectRevert(abi.encodeWithSelector(TreeBotExecutionVault.TradeLimitExceeded.selector));
        vault.executeSwap(bytes32(uint256(6)), address(tokenIn), address(tokenOut), 1_001, 1,
            address(target), address(target), bytes(""), uint64(block.timestamp + 1 hours));
    }

    function testDailyAggregateCapRejectsThirdSwap() public {
        _execute(bytes32(uint256(7)), 900, 1, 100);
        _execute(bytes32(uint256(8)), 900, 1, 100);
        vm.prank(EXECUTOR);
        vm.expectRevert(abi.encodeWithSelector(TreeBotExecutionVault.DailyLimitExceeded.selector));
        vault.executeSwap(bytes32(uint256(9)), address(tokenIn), address(tokenOut), 900, 1,
            address(target), address(target),
            abi.encodeCall(MockSwapTarget.swap, (address(tokenIn), address(tokenOut), uint256(900), uint256(100), address(vault))),
            uint64(block.timestamp + 1 hours));
    }

    function testTokenPairMustBeExplicitlyAllowed() public {
        vm.prank(EXECUTOR);
        vm.expectRevert(abi.encodeWithSelector(TreeBotExecutionVault.PairNotAllowed.selector));
        vault.executeSwap(bytes32(uint256(10)), address(tokenOut), address(tokenIn), 100, 1,
            address(target), address(target),
            abi.encodeCall(MockSwapTarget.swap, (address(tokenOut), address(tokenIn), uint256(100), uint256(100), address(vault))),
            uint64(block.timestamp + 1 hours));
    }

    function testExecutorExpiryAndRevocationAreEnforcedOnChain() public {
        vault.authorizeExecutor(EXECUTOR, uint64(block.timestamp + 1 hours));
        vm.warp(block.timestamp + 1 hours);
        vm.prank(EXECUTOR);
        vm.expectRevert(abi.encodeWithSelector(TreeBotExecutionVault.AuthorizationExpired.selector));
        vault.executeSwap(bytes32(uint256(11)), address(tokenIn), address(tokenOut), 100, 1,
            address(target), address(target), bytes(""), uint64(block.timestamp + 1 hours));
        vault.authorizeExecutor(EXECUTOR, uint64(block.timestamp + 1 days));
        vault.revokeExecutor();
        vm.prank(EXECUTOR);
        vm.expectRevert(abi.encodeWithSelector(TreeBotExecutionVault.Unauthorized.selector));
        vault.executeSwap(bytes32(uint256(12)), address(tokenIn), address(tokenOut), 100, 1,
            address(target), address(target), bytes(""), uint64(block.timestamp + 1 hours));
    }

    function testWrongChainIsRejected() public {
        vm.chainId(1);
        vm.prank(EXECUTOR);
        vm.expectRevert(abi.encodeWithSelector(TreeBotExecutionVault.WrongChain.selector));
        vault.executeSwap(bytes32(uint256(13)), address(tokenIn), address(tokenOut), 100, 1,
            address(target), address(target), bytes(""), uint64(block.timestamp + 1 hours));
    }
}
