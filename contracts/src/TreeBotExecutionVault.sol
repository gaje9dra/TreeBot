// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Restricted, single-owner ERC-20 vault for an unattended executor.
/// @dev Test-environment implementation only. Independent security review is required before any real funds.
contract TreeBotExecutionVault {
    error Unauthorized();
    error WrongChain();
    error EmergencyStopActive();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidPolicy();
    error AuthorizationExpired();
    error DeadlineInvalid();
    error TokenNotAllowed();
    error PairNotAllowed();
    error TargetNotAllowed();
    error SpenderNotAllowed();
    error TradeLimitExceeded();
    error DailyLimitExceeded();
    error IntentAlreadyUsed();
    error InputDeltaMismatch();
    error MinimumOutputNotMet();
    error TokenCallFailed();
    error ExternalCallFailed(bytes reason);
    error Reentrancy();

    uint256 public constant REQUIRED_CHAIN_ID = 137;
    address public immutable owner;
    address public executor;
    uint64 public executorExpiresAt;
    bool public emergencyStop = true;
    bool private entered;

    mapping(address => bool) public tokenAllowed;
    mapping(address => uint256) public maxTradeAmount;
    mapping(address => uint256) public dailySpendCap;
    mapping(address => mapping(uint256 => uint256)) public dailySpent;
    mapping(bytes32 => bool) public pairAllowed;
    mapping(address => bool) public targetAllowed;
    mapping(address => bool) public spenderAllowed;
    mapping(bytes32 => bool) public usedIntent;

    event ExecutorAuthorized(address indexed executor, uint64 expiresAt);
    event ExecutorRevoked(address indexed executor);
    event EmergencyStopChanged(bool stopped);
    event TokenPolicyChanged(address indexed token, bool allowed, uint256 maxTradeAmount, uint256 dailySpendCap);
    event PairPolicyChanged(address indexed tokenIn, address indexed tokenOut, bool allowed);
    event TargetPolicyChanged(address indexed target, bool allowed);
    event SpenderPolicyChanged(address indexed spender, bool allowed);
    event Deposit(address indexed owner, address indexed token, uint256 amount);
    event Withdrawal(address indexed owner, address indexed token, address indexed recipient, uint256 amount);
    event SwapExecuted(
        bytes32 indexed intentId,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        address target,
        uint256 dayBucket
    );

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier onlyExecutor() {
        if (msg.sender != executor || executor == address(0)) revert Unauthorized();
        if (block.chainid != REQUIRED_CHAIN_ID) revert WrongChain();
        if (emergencyStop) revert EmergencyStopActive();
        if (block.timestamp >= executorExpiresAt) revert AuthorizationExpired();
        _;
    }

    modifier nonReentrant() {
        if (entered) revert Reentrancy();
        entered = true;
        _;
        entered = false;
    }

    constructor() {
        owner = msg.sender;
    }

    function authorizeExecutor(address nextExecutor, uint64 expiresAt) external onlyOwner {
        if (nextExecutor == address(0) || nextExecutor == owner) revert InvalidAddress();
        if (expiresAt <= block.timestamp) revert AuthorizationExpired();
        executor = nextExecutor;
        executorExpiresAt = expiresAt;
        emit ExecutorAuthorized(nextExecutor, expiresAt);
    }

    function revokeExecutor() external onlyOwner {
        address old = executor;
        executor = address(0);
        executorExpiresAt = 0;
        emit ExecutorRevoked(old);
    }

    function setEmergencyStop(bool stopped) external onlyOwner {
        emergencyStop = stopped;
        emit EmergencyStopChanged(stopped);
    }

    function setTokenPolicy(address token, bool allowed, uint256 perTradeCap, uint256 dailyCap) external onlyOwner {
        if (token == address(0) || token.code.length == 0) revert InvalidAddress();
        if (allowed && (perTradeCap == 0 || dailyCap < perTradeCap)) revert InvalidPolicy();
        tokenAllowed[token] = allowed;
        maxTradeAmount[token] = allowed ? perTradeCap : 0;
        dailySpendCap[token] = allowed ? dailyCap : 0;
        emit TokenPolicyChanged(token, allowed, maxTradeAmount[token], dailySpendCap[token]);
    }

    function setPairAllowed(address tokenIn, address tokenOut, bool allowed) external onlyOwner {
        if (tokenIn == address(0) || tokenOut == address(0) || tokenIn == tokenOut) revert InvalidAddress();
        pairAllowed[_pairKey(tokenIn, tokenOut)] = allowed;
        emit PairPolicyChanged(tokenIn, tokenOut, allowed);
    }

    function setTargetAllowed(address target, bool allowed) external onlyOwner {
        if (target == address(0) || target.code.length == 0) revert InvalidAddress();
        targetAllowed[target] = allowed;
        emit TargetPolicyChanged(target, allowed);
    }

    function setSpenderAllowed(address spender, bool allowed) external onlyOwner {
        if (spender == address(0) || spender.code.length == 0) revert InvalidAddress();
        spenderAllowed[spender] = allowed;
        emit SpenderPolicyChanged(spender, allowed);
    }

    /// @notice Owner-funded ERC-20 deposit. The caller must first approve this vault for this amount.
    function deposit(address token, uint256 amount) external onlyOwner nonReentrant {
        if (block.chainid != REQUIRED_CHAIN_ID) revert WrongChain();
        if (!tokenAllowed[token]) revert TokenNotAllowed();
        if (amount == 0) revert InvalidAmount();
        _safeTransferFrom(token, msg.sender, address(this), amount);
        emit Deposit(msg.sender, token, amount);
    }

    /// @notice Owner-only release; it remains available while trading is paused.
    function withdraw(address token, address recipient, uint256 amount) external onlyOwner nonReentrant {
        if (block.chainid != REQUIRED_CHAIN_ID) revert WrongChain();
        if (token.code.length == 0 || recipient == address(0) || amount == 0) revert InvalidAddress();
        _safeTransfer(token, recipient, amount);
        emit Withdrawal(msg.sender, token, recipient, amount);
    }

    /// @notice Execute exactly one allowlisted token swap. The target call must spend exactly amountIn
    /// and deliver at least minAmountOut of tokenOut back to this vault. Any violation reverts atomically.
    /// @dev This balance-delta guard limits loss even though aggregator calldata is opaque; target/spender
    /// policy must still be independently reviewed. No native-value or arbitrary-call entry point exists.
    function executeSwap(
        bytes32 intentId,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address target,
        address spender,
        bytes calldata data,
        uint64 deadline
    ) external onlyExecutor nonReentrant returns (uint256 actualAmountOut) {
        if (intentId == bytes32(0)) revert InvalidAddress();
        if (usedIntent[intentId]) revert IntentAlreadyUsed();
        if (deadline < block.timestamp || deadline > executorExpiresAt) revert DeadlineInvalid();
        if (tokenIn == address(0) || tokenOut == address(0) || tokenIn == tokenOut || amountIn == 0 || minAmountOut == 0) {
            revert InvalidAmount();
        }
        if (!tokenAllowed[tokenIn] || !tokenAllowed[tokenOut]) revert TokenNotAllowed();
        if (!pairAllowed[_pairKey(tokenIn, tokenOut)]) revert PairNotAllowed();
        if (!targetAllowed[target]) revert TargetNotAllowed();
        if (!spenderAllowed[spender]) revert SpenderNotAllowed();
        if (amountIn > maxTradeAmount[tokenIn]) revert TradeLimitExceeded();

        uint256 dayBucket = block.timestamp / 1 days;
        uint256 spentToday = dailySpent[tokenIn][dayBucket];
        if (spentToday > dailySpendCap[tokenIn] || amountIn > dailySpendCap[tokenIn] - spentToday) {
            revert DailyLimitExceeded();
        }

        uint256 inputBefore = _balanceOf(tokenIn, address(this));
        uint256 outputBefore = _balanceOf(tokenOut, address(this));
        if (inputBefore < amountIn) revert InvalidAmount();

        // Mark intent and reserve spending before interaction; any revert rolls these changes back.
        usedIntent[intentId] = true;
        dailySpent[tokenIn][dayBucket] = spentToday + amountIn;

        // Allow only this amount, only to the independently configured spender, and clear it afterwards.
        _safeApprove(tokenIn, spender, 0);
        _safeApprove(tokenIn, spender, amountIn);
        (bool success, bytes memory reason) = target.call(data);
        if (!success) revert ExternalCallFailed(reason);
        _safeApprove(tokenIn, spender, 0);

        uint256 inputAfter = _balanceOf(tokenIn, address(this));
        uint256 outputAfter = _balanceOf(tokenOut, address(this));
        if (inputAfter > inputBefore || inputBefore - inputAfter != amountIn) revert InputDeltaMismatch();
        if (outputAfter < outputBefore || outputAfter - outputBefore < minAmountOut) revert MinimumOutputNotMet();

        actualAmountOut = outputAfter - outputBefore;
        emit SwapExecuted(intentId, tokenIn, tokenOut, amountIn, actualAmountOut, target, dayBucket);
    }

    function balanceOf(address token) external view returns (uint256) {
        return _balanceOf(token, address(this));
    }

    function _pairKey(address tokenIn, address tokenOut) private pure returns (bytes32) {
        return keccak256(abi.encode(tokenIn, tokenOut));
    }

    function _balanceOf(address token, address account) private view returns (uint256 result) {
        (bool success, bytes memory data) = token.staticcall(abi.encodeWithSelector(bytes4(keccak256("balanceOf(address)")), account));
        if (!success || data.length < 32) revert TokenCallFailed();
        result = abi.decode(data, (uint256));
    }

    function _safeTransfer(address token, address recipient, uint256 amount) private {
        if (token.code.length == 0) revert TokenCallFailed();
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(bytes4(keccak256("transfer(address,uint256)")), recipient, amount));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenCallFailed();
    }

    function _safeTransferFrom(address token, address from, address recipient, uint256 amount) private {
        if (token.code.length == 0) revert TokenCallFailed();
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(bytes4(keccak256("transferFrom(address,address,uint256)")), from, recipient, amount));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenCallFailed();
    }

    function _safeApprove(address token, address spender, uint256 amount) private {
        if (token.code.length == 0) revert TokenCallFailed();
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(bytes4(keccak256("approve(address,uint256)")), spender, amount));
        if (!success || (data.length != 0 && !abi.decode(data, (bool)))) revert TokenCallFailed();
    }
}
