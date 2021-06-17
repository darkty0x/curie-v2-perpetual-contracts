import { expect } from "chai"
import { parseEther } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { TestERC20, TestUniswapV3Broker, UniswapV3Pool } from "../../typechain"
import { base0Quote1PoolFixture, base1Quote0PoolFixture } from "../shared/fixtures"
import { encodePriceSqrt } from "../shared/utilities"

describe("UniswapV3Broker mint", () => {
    const [wallet] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([wallet])
    let pool: UniswapV3Pool
    let baseToken: TestERC20
    let quoteToken: TestERC20
    let uniswapV3Broker: TestUniswapV3Broker

    // https://docs.google.com/spreadsheets/d/1H8Sn0YHwbnEjhhA03QOVfOFPPFZUX5Uasg14UY9Gszc/edit#gid=1867451918
    describe("# mint: isBase0Quote1 / token0 == base", () => {
        beforeEach(async () => {
            const {
                factory,
                pool: _pool,
                baseToken: _baseToken,
                quoteToken: _quoteToken,
            } = await loadFixture(base0Quote1PoolFixture)
            pool = _pool
            baseToken = _baseToken
            quoteToken = _quoteToken

            const UniswapV3BrokerFactory = await ethers.getContractFactory("TestUniswapV3Broker")
            uniswapV3Broker = (await UniswapV3BrokerFactory.deploy(factory.address)) as TestUniswapV3Broker

            // broker has the only permission to mint vToken
            await baseToken.setMinter(uniswapV3Broker.address)
            await quoteToken.setMinter(uniswapV3Broker.address)
        })

        // https://docs.google.com/spreadsheets/d/1xcWBBcQYwWuWRdlHtNv64tOjrBCnnvj_t1WEJaQv8EY/edit#gid=150902425
        it("mint range order includes current price", async () => {
            // the current price of token0 (base) = reserve1/reserve0 = 151.3733069/1
            // P(50200) = 1.0001^50200 ~= 151.3733069
            await pool.initialize(encodePriceSqrt(151.3733069, 1))

            const base = parseEther("0.000808693720084599")
            const quote = parseEther("0.122414646")

            // the emission of event is from Uniswap v3, with params representing the real minting conditions
            await expect(
                uniswapV3Broker.mint({
                    pool: pool.address,
                    baseToken: baseToken.address,
                    quoteToken: quoteToken.address,
                    lowerTick: 50000, // 148.3760629
                    upperTick: 50400, // 154.4310961
                    base,
                    quote,
                }),
            )
                .to.emit(pool, "Mint")
                .withArgs(
                    uniswapV3Broker.address,
                    uniswapV3Broker.address,
                    50000,
                    50400,
                    "999999986406400213", // around 1
                    base,
                    quote,
                )
        })

        it("mint range order above current price", async () => {
            await pool.initialize(encodePriceSqrt(1, 1))

            // LP opens a range order above the current price means that LP expects the price of token0 (base) to rise,
            // and traders would like to buy token0, so LP provides token0 to be bought
            // when above price, token1 = 0
            const base = parseEther("0.000816820841")
            const quote = "0"

            // the emission of event is from Uniswap v3, with params representing the real minting conditions
            await expect(
                uniswapV3Broker.mint({
                    pool: pool.address,
                    baseToken: baseToken.address,
                    quoteToken: quoteToken.address,
                    lowerTick: 50000,
                    upperTick: 50200,
                    base,
                    quote,
                }),
            )
                .to.emit(pool, "Mint")
                .withArgs(
                    uniswapV3Broker.address,
                    uniswapV3Broker.address,
                    50000,
                    50200,
                    "999999999994411796", // around 1
                    base,
                    quote,
                )
        })

        it("mint range order above current price should fail if we don't provide base", async () => {
            await pool.initialize(encodePriceSqrt(1, 1))

            const base = "0"
            const quote = parseEther("0.122414646")

            await expect(
                uniswapV3Broker.mint({
                    pool: pool.address,
                    baseToken: baseToken.address,
                    quoteToken: quoteToken.address,
                    lowerTick: "50000",
                    upperTick: "50200",
                    base,
                    quote,
                }),
            ).not.to.emit(pool, "Mint")
        })

        it("mint range order under current price", async () => {
            await pool.initialize(encodePriceSqrt(200, 1))

            // LP opens a range order under the current price means that LP expects the price of token0 (base) to drop
            // and traders would like to sell token0, so LP provides token1 (quote) to buy traders' token0
            // when under price, token0 = 0
            const base = "0"
            const quote = parseEther("0.122414646")

            await expect(
                uniswapV3Broker.mint({
                    pool: pool.address,
                    baseToken: baseToken.address,
                    quoteToken: quoteToken.address,
                    lowerTick: "50000",
                    upperTick: "50200",
                    base,
                    quote,
                }),
            )
                .to.emit(pool, "Mint")
                .withArgs(
                    uniswapV3Broker.address,
                    uniswapV3Broker.address,
                    50000,
                    50200,
                    "1000000000109464931", // around 1
                    base,
                    quote,
                )
        })

        it("mint range order under current price should fail if we don't provide quote", async () => {
            await pool.initialize(encodePriceSqrt(200, 1))

            const base = parseEther("0.000816820841")
            const quote = "0"

            await expect(
                uniswapV3Broker.mint({
                    pool: pool.address,
                    baseToken: baseToken.address,
                    quoteToken: quoteToken.address,
                    lowerTick: "50000",
                    upperTick: "50200",
                    base,
                    quote,
                }),
            ).not.to.emit(pool, "Mint")
        })
    })

    describe("# mint: !isBase0Quote1 / token0 == quote", () => {
        beforeEach(async () => {
            // get pool with reverse token order
            const {
                factory,
                pool: _pool,
                baseToken: _baseToken,
                quoteToken: _quoteToken,
            } = await loadFixture(base1Quote0PoolFixture)
            pool = _pool
            baseToken = _baseToken
            quoteToken = _quoteToken

            const UniswapV3BrokerFactory = await ethers.getContractFactory("TestUniswapV3Broker")
            uniswapV3Broker = (await UniswapV3BrokerFactory.deploy(factory.address)) as TestUniswapV3Broker

            // broker has the only permission to mint vToken
            await baseToken.setMinter(uniswapV3Broker.address)
            await quoteToken.setMinter(uniswapV3Broker.address)
        })

        it("mint range order includes current price", async () => {
            // the current price of token1 (base) = reserve0/reserve1 = 151.3733069/1
            // P(50200) = 1.0001^50200 ~= 151.3733069
            await pool.initialize(encodePriceSqrt(1, 151.3733069))

            const base = parseEther("0.000808693720084599")
            const quote = parseEther("0.122414646")

            // the emission of event is from Uniswap v3, with params representing the real minting conditions
            // the current price of token0 (quote) = reserve1/reserve0 = 1/151.3733069 = 0.00660618454
            await expect(
                uniswapV3Broker.mint({
                    pool: pool.address,
                    baseToken: baseToken.address,
                    quoteToken: quoteToken.address,
                    lowerTick: 50000, // 148.3760629
                    upperTick: 50400, // 154.4310961
                    base,
                    quote,
                }),
            )
                .to.emit(pool, "Mint")
                .withArgs(
                    uniswapV3Broker.address,
                    uniswapV3Broker.address,
                    -50400, // 0.00647537979
                    -50000, // 0.00673963158
                    "999999986406400213", // around 1
                    quote,
                    base,
                )
        })

        it("mint range order above current price", async () => {
            await pool.initialize(encodePriceSqrt(1, 1))

            // when above price, token1 = 0
            const base = parseEther("0.000816820841")
            const quote = "0"

            // the emission of event is from Uniswap v3, with params representing the real minting conditions
            // thus, since the order of tokens is reverse, expected ticks & amounts are also reverse, while liquidity remains the same
            await expect(
                uniswapV3Broker.mint({
                    pool: pool.address,
                    baseToken: baseToken.address,
                    quoteToken: quoteToken.address,
                    lowerTick: 50000,
                    upperTick: 50200,
                    base,
                    quote,
                }),
            )
                .to.emit(pool, "Mint")
                .withArgs(
                    uniswapV3Broker.address,
                    uniswapV3Broker.address,
                    -50200,
                    -50000,
                    "999999999994411796", // around 1
                    quote,
                    base,
                )
            // the meaning of the last two params emitted: (token0 used, token1 used)
            // the amount of token0 == quote used is as expected == 0, and token1 == base == 0.000816820841 as well
        })

        it("mint range order above current price should fail if we don't provide base", async () => {
            await pool.initialize(encodePriceSqrt(1, 1))

            const base = "0"
            const quote = parseEther("0.122414646")

            await expect(
                uniswapV3Broker.mint({
                    pool: pool.address,
                    baseToken: baseToken.address,
                    quoteToken: quoteToken.address,
                    lowerTick: "50000",
                    upperTick: "50200",
                    base,
                    quote,
                }),
            ).not.to.emit(pool, "Mint")
        })

        it("mint range order under current price", async () => {
            // since the order of tokens is reverse, the initialized price should be the reciprocal of the above case
            await pool.initialize(encodePriceSqrt(1, 200))

            // when under price, token0 = 0
            const base = "0"
            const quote = parseEther("0.122414646")

            await expect(
                uniswapV3Broker.mint({
                    pool: pool.address,
                    baseToken: baseToken.address,
                    quoteToken: quoteToken.address,
                    lowerTick: "50000",
                    upperTick: "50200",
                    base,
                    quote,
                }),
            )
                .to.emit(pool, "Mint")
                .withArgs(
                    uniswapV3Broker.address,
                    uniswapV3Broker.address,
                    -50200,
                    -50000,
                    "1000000000109464931", // around 1
                    quote,
                    base,
                )
            // the meaning of the last two params emitted: (token0 used, token1 used)
            // the amount of token0 == quote used is as expected == 0.122414646, and token1 == base == 0 as well
        })

        it("mint range order under current price should fail if we don't provide quote", async () => {
            await pool.initialize(encodePriceSqrt(1, 200))

            const base = parseEther("0.000816820841")
            const quote = "0"

            await expect(
                uniswapV3Broker.mint({
                    pool: pool.address,
                    baseToken: baseToken.address,
                    quoteToken: quoteToken.address,
                    lowerTick: "50000",
                    upperTick: "50200",
                    base,
                    quote,
                }),
            ).not.to.emit(pool, "Mint")
        })
    })
})