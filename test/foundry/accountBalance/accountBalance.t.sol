pragma solidity 0.7.6;
pragma abicoder v2;

import "forge-std/Test.sol";
import "../helper/Setup.sol";
import "../../../contracts/interface/IIndexPrice.sol";
import "../../../contracts/interface/IBaseToken.sol";
import "../interface/IAccountBalanceEvent.sol";
import { IUniswapV3PoolState } from "@uniswap/v3-core/contracts/interfaces/pool/IUniswapV3PoolState.sol";
import { IUniswapV3PoolDerivedState } from "@uniswap/v3-core/contracts/interfaces/pool/IUniswapV3PoolDerivedState.sol";
import { FixedPoint96 } from "@uniswap/v3-core/contracts/libraries/FixedPoint96.sol";

contract AccountBalanceTest is IAccountBalanceEvent, Setup {
    using SafeMathUpgradeable for uint256;

    function setUp() public virtual override {
        Setup.setUp();

        // initial market
        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(100, 0, 0, 0, 0, 0, false)
        );
        marketRegistry.addPool(address(baseToken), pool.fee());
    }

    function test_setMarketRegistry_should_emit_event() public {
        vm.expectEmit(true, false, false, true, address(accountBalance));
        emit MarketRegistryChanged(address(marketRegistry));

        accountBalance.setMarketRegistry(address(marketRegistry));

        assertEq(accountBalance.getMarketRegistry(), address(marketRegistry));
    }

    function test_getMarkPrice_should_return_index_twap_if_marketRegistry_not_set() public {
        // mock index twap
        uint32 indexTwapInterval = clearingHouseConfig.getTwapInterval();
        uint256 indexTwap = 100;
        _mockIndexTwap(address(baseToken), indexTwapInterval, indexTwap);

        assertEq(accountBalance.getMarkPrice(address(baseToken)), indexTwap);
    }

    function test_getMarkPrice_should_return_index_twap_if_market_twap_interval_is_zero() public {
        accountBalance.setMarketRegistry(address(marketRegistry));

        // mock market twap interval is zero
        _mockMarkPriceMarketTwapInterval(0);

        // mock index twap
        uint32 indexTwapInterval = clearingHouseConfig.getTwapInterval();
        uint256 indexTwap = 100;
        _mockIndexTwap(address(baseToken), indexTwapInterval, indexTwap);

        assertEq(accountBalance.getMarkPrice(address(baseToken)), indexTwap);
    }

    function test_getMarkPrice_should_return_index_twap_if_premium_interval_is_zero() public {
        accountBalance.setMarketRegistry(address(marketRegistry));

        // mock premium interval is zero
        _mockMarkPricePremiumInterval(0);

        // mock index twap
        uint32 indexTwapInterval = clearingHouseConfig.getTwapInterval();
        uint256 indexTwap = 100;
        _mockIndexTwap(address(baseToken), indexTwapInterval, indexTwap);

        assertEq(accountBalance.getMarkPrice(address(baseToken)), indexTwap);
    }

    function test_getMarkPrice_should_return_index_twap_if_market_is_not_open() public {
        accountBalance.setMarketRegistry(address(marketRegistry));

        // mock baseToken is not open
        vm.mockCall(address(baseToken), abi.encodeWithSelector(IBaseToken.isOpen.selector), abi.encode(false));

        // mock baseToken index twap
        uint32 indexTwapInterval = clearingHouseConfig.getTwapInterval();
        uint256 indexTwap = 100;
        _mockIndexTwap(address(baseToken), indexTwapInterval, indexTwap);

        vm.expectCall(address(baseToken), abi.encodeWithSelector(IBaseToken.isOpen.selector));
        assertEq(accountBalance.getMarkPrice(address(baseToken)), indexTwap);
    }

    function test_getMarkPrice_should_return_index_price_with_premium_if_enable_mark_price() public {
        accountBalance.setMarketRegistry(address(marketRegistry));

        (uint32 marketTwapInterval, uint32 premiumInterval) = clearingHouseConfig.getMarkPriceConfigs();

        // mock current market price, price = 100
        uint256 sqrtPrice = 10;
        _mockMarketPrice(address(pool), sqrtPrice);

        // mock market twap(30min): price = 95, tick = 45541
        _mockMarketTwap(address(pool), marketTwapInterval, 45541);

        // mock moving average: index + premium(15min), price = 97
        // 100 + (-3) = 97
        // mock index price: 100
        _mockIndexTwap(address(baseToken), 0, 100 * (10**18));

        // mock market twap(15m): price = 95, tick = 45541
        _mockMarketTwap(address(pool), premiumInterval, 45541);

        // mock index twap(15m), price = 98
        _mockIndexTwap(address(baseToken), premiumInterval, 98 * (10**18));

        uint256 result = accountBalance.getMarkPrice(address(baseToken));
        // median[100, 95, 97] = 97
        assertApproxEqAbs(result, 97 * (10**18), 10**15); // result should be 97 +/- 0.001, due to tick math
    }

    function _toUint160(uint256 value) internal pure returns (uint160 returnValue) {
        require(((returnValue = uint160(value)) == value), "SafeCast: value doesn't fit in 160 bits");
    }

    function _mockMarkPriceMarketTwapInterval(uint32 interval) internal {
        (, uint32 premiumInterval) = clearingHouseConfig.getMarkPriceConfigs();

        vm.mockCall(
            address(clearingHouseConfig),
            abi.encodeWithSelector(IClearingHouseConfig.getMarkPriceConfigs.selector),
            abi.encode(interval, premiumInterval)
        );
    }

    function _mockMarkPricePremiumInterval(uint32 interval) internal {
        (uint32 marketTwapInterval, ) = clearingHouseConfig.getMarkPriceConfigs();
        vm.mockCall(
            address(clearingHouseConfig),
            abi.encodeWithSelector(IClearingHouseConfig.getMarkPriceConfigs.selector),
            abi.encode(marketTwapInterval, interval)
        );
    }

    function _mockIndexTwap(
        address baseToken,
        uint32 interval,
        uint256 price
    ) internal {
        vm.mockCall(baseToken, abi.encodeWithSelector(IIndexPrice.getIndexPrice.selector, interval), abi.encode(price));
    }

    function _mockMarketPrice(address pool, uint256 sqrtPrice) internal {
        uint160 sqrtPriceX96 = _toUint160(sqrtPrice.mul(FixedPoint96.Q96));
        vm.mockCall(
            pool,
            abi.encodeWithSelector(IUniswapV3PoolState.slot0.selector),
            abi.encode(sqrtPriceX96, 0, 0, 0, 0, 0, false)
        );
    }

    function _mockMarketTwap(
        address pool,
        uint32 interval,
        int56 tick
    ) internal {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = interval;
        secondsAgos[1] = 0;

        // Ex: interval = 30m, tick = 95
        // Price: |---- 95 (10min)---|---- 95 (10min)---|---- 95 (10min)----|
        // Tick:  |-- 45541 (10min)--|-- 45541 (10min)--|-- 45541 (10min) --|

        int56[] memory tickCumulatives = new int56[](2);
        tickCumulatives[0] = 0;
        tickCumulatives[1] = tick * interval;

        uint160[] memory secondsPerLiquidityCumulativeX128s = new uint160[](2); // dummy

        vm.mockCall(
            address(pool),
            abi.encodeWithSelector(IUniswapV3PoolDerivedState.observe.selector, secondsAgos),
            abi.encode(tickCumulatives, secondsPerLiquidityCumulativeX128s)
        );
    }
}
