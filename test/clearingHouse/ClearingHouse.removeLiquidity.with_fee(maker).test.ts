import { expect } from "chai"
import { BigNumber } from "ethers"
import { parseEther, parseUnits } from "ethers/lib/utils"
import { ethers, waffle } from "hardhat"
import { BaseToken, Exchange, QuoteToken, TestClearingHouse, TestERC20, UniswapV3Pool, Vault } from "../../typechain"
import { deposit } from "../helper/token"
import { encodePriceSqrt } from "../shared/utilities"
import { BaseQuoteOrdering, createClearingHouseFixture } from "./fixtures"

describe("ClearingHouse removeLiquidity with fee", () => {
    const [admin, alice, bob, carol] = waffle.provider.getWallets()
    const loadFixture: ReturnType<typeof waffle.createFixtureLoader> = waffle.createFixtureLoader([admin])
    let clearingHouse: TestClearingHouse
    let exchange: Exchange
    let collateral: TestERC20
    let vault: Vault
    let baseToken: BaseToken
    let quoteToken: QuoteToken
    let pool: UniswapV3Pool
    let baseAmount: BigNumber
    let quoteAmount: BigNumber

    beforeEach(async () => {
        const _clearingHouseFixture = await loadFixture(createClearingHouseFixture(BaseQuoteOrdering.BASE_0_QUOTE_1))
        clearingHouse = _clearingHouseFixture.clearingHouse as TestClearingHouse
        exchange = _clearingHouseFixture.exchange
        vault = _clearingHouseFixture.vault
        collateral = _clearingHouseFixture.USDC
        baseToken = _clearingHouseFixture.baseToken
        quoteToken = _clearingHouseFixture.quoteToken
        pool = _clearingHouseFixture.pool
        baseAmount = parseUnits("100", await baseToken.decimals())
        quoteAmount = parseUnits("10000", await quoteToken.decimals())

        const collateralDecimals = await collateral.decimals()
        // mint
        collateral.mint(admin.address, parseUnits("10000", collateralDecimals))

        // prepare collateral for alice
        const amount = parseUnits("1000", await collateral.decimals())
        await collateral.transfer(alice.address, amount)
        await deposit(alice, vault, 1000, collateral)

        // prepare collateral for bob
        await collateral.transfer(bob.address, amount)
        await deposit(bob, vault, 1000, collateral)

        // prepare collateral for carol
        await collateral.transfer(carol.address, amount)
        await deposit(carol, vault, 1000, collateral)
    })

    // simulation results:
    // https://docs.google.com/spreadsheets/d/1H8Sn0YHwbnEjhhA03QOVfOFPPFZUX5Uasg14UY9Gszc/edit#gid=1867451918

    describe("remove zero liquidity", () => {
        describe("one maker; current price is in maker's range", () => {
            it("a trader swaps base to quote, thus the maker receives B2QFee in ClearingHouse (B2QFee)", async () => {
                await pool.initialize(encodePriceSqrt(151.3733069, 1))
                // the initial number of oracle can be recorded is 1; thus, have to expand it
                await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)

                // add pool after it's initialized
                await exchange.addPool(baseToken.address, 10000)

                const lowerTick = "50000"
                const upperTick = "50200"

                // alice add liquidity
                const addLiquidityParams = {
                    baseToken: baseToken.address,
                    base: "0",
                    quote: parseEther("0.122414646"),
                    lowerTick, // 148.3760629
                    upperTick, // 151.3733069
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                }
                // will mint 0.122414646 quote -> transfer to pool
                await clearingHouse.connect(alice).addLiquidity(addLiquidityParams)

                // liquidity ~= 1
                const liquidity = (await exchange.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick))
                    .liquidity

                // bob swap
                // base: 0.0004084104205
                // B2QFee: CH actually shorts 0.0004084104205 / 0.99 = 0.0004125357783 and get 0.06151334175725025 quote
                // bob gets 0.06151334175725025 * 0.99 = 0.06089820833967775
                // will mint 0.0004084104205 base -> transfer to pool
                await clearingHouse.connect(bob).openPosition({
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("0.0004084104205"),
                    sqrtPriceLimitX96: "0",
                    deadline: ethers.constants.MaxUint256,
                    referralCode: ethers.constants.HashZero,
                })

                // alice remove liq 0, alice should collect fee
                const removeLiquidityParams = {
                    baseToken: baseToken.address,
                    lowerTick,
                    upperTick,
                    liquidity: "0",
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                }

                // Check uncollected fees by using static call
                const response = await clearingHouse.connect(alice).callStatic.removeLiquidity(removeLiquidityParams)
                expect(response.fee).to.be.eq("615133417572502")
                expect(response.base).to.be.eq("0")
                expect(response.quote).to.be.eq("0")

                // B2QFee: expect 1% of quote = 0.0006151334175725025 ~= 615133417572502 / 10^18
                // will transfer all 0.0004084104205 base the the remaining quote to CH
                // will collect and burn all extra base and quote tokens (Uniswap v3 pool fees that we are not using)
                await expect(clearingHouse.connect(alice).removeLiquidity(removeLiquidityParams))
                    .to.emit(exchange, "LiquidityChanged")
                    .withArgs(
                        alice.address,
                        baseToken.address,
                        quoteToken.address,
                        Number(lowerTick),
                        Number(upperTick),
                        "0",
                        "0",
                        "0",
                        "615133417572502",
                    )

                // alice received 0.0006151334175725025 quote tokens as fee
                expect(await clearingHouse.getOwedRealizedPnl(alice.address)).to.eq("615133417572502")

                // no base fee, and excess vTokens should be auto-burnt
                expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                    parseEther("0"), // available
                    parseEther("0"), // debt
                ])
                // 10000 - 0.122414646 (added liquidity) = 9999.877585354
                // auto-burnt:
                //   available = 9999.877585354 -> 0
                //   debt = 10000 -> 10000 - 9999.877585354 = 0.122414646
                expect(await clearingHouse.getTokenInfo(alice.address, quoteToken.address)).to.deep.eq([
                    parseEther("0"), // available
                    parseEther("0.122414646"), // debt
                ])
                // note skipping Bob's/ taker's balance

                // B2QFee: there is only quote fee
                // 0.000615133417572502 * 2 ^ 128 = 2.093190553037369773206693664E+35
                // =  209319055303736977320669366400000000
                // ~= 209319055280824225842992700263677914
                const openOrder = await exchange.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
                expect(openOrder).to.deep.eq([
                    liquidity,
                    Number(lowerTick), // lowerTick
                    Number(upperTick), // upperTick
                    // add the decimal point to prevent overflow, according to the following 10^18 comparison
                    // 209319055280823885560625816574200262
                    //                  1000000000000000000
                    parseEther("209319055280824225.842992700263677914"), // feeGrowthInsideClearingHouseLastX128
                    openOrder.lastTwPremiumGrowthInsideX96, // we don't verify the number here
                    openOrder.lastTwPremiumGrowthBelowX96, // we don't verify the number here
                    openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96, // we don't verify the number here
                ])

                // all base tokens should've been burnt by now
                const baseTokenInfo = await clearingHouse.getTokenInfo(alice.address, baseToken.address)
                expect(baseTokenInfo.available).be.eq(0)
                // alice should've burnt all the quote tokens (only liquidity, fee is being realized) she received
                // from the removing liquidity, so the remaining quote tokens are all bob's
                const quoteTokenInfo = await clearingHouse.getTokenInfo(bob.address, quoteToken.address)
                expect(quoteTokenInfo.available).be.closeTo(parseEther("0.060898208339677747"), 1)
            })

            describe("initialized price = 148.3760629", () => {
                beforeEach(async () => {
                    await pool.initialize(encodePriceSqrt(148.3760629, 1))
                    // the initial number of oracle can be recorded is 1; thus, have to expand it
                    await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)

                    // add pool after it's initialized
                    await exchange.addPool(baseToken.address, 10000)
                })

                it("a trader swaps quote to base, thus the maker receives quote fee in Uniswap", async () => {
                    const lowerTick = "50000"
                    const upperTick = "50200"

                    // add base liquidity
                    const addLiquidityParams = {
                        baseToken: baseToken.address,
                        lowerTick, // 148.3760629
                        upperTick, // 151.3733069
                        base: parseEther("0.000816820841"),
                        quote: "0",
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }
                    // will mint 0.000816820841 base -> transfer to pool
                    await clearingHouse.connect(alice).addLiquidity(addLiquidityParams)

                    // liquidity ~= 1
                    const liquidity = (
                        await exchange.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
                    ).liquidity

                    // bob swap
                    // quote: 0.112414646 / 0.99 = 0.1135501475
                    // to base: 0.0007507052579
                    const swapParams = {
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: true,
                        oppositeAmountBound: 0,
                        amount: parseEther("0.1135501475"),
                        sqrtPriceLimitX96: "0",
                    }
                    // will mint 0.1135501475 quote (plus extra for offsetting Uniswap fee) -> transfer to pool
                    await clearingHouse.connect(bob).swap(swapParams)

                    // alice remove liq 0, alice should collect fee
                    const removeLiquidityParams = {
                        baseToken: baseToken.address,
                        lowerTick,
                        upperTick,
                        liquidity: "0",
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }

                    // 0.001135501474999999 - fee in uniswap
                    // expect 1% of quote = 0.001135501475
                    // there's one wei of imprecision, thus expecting 0.001135501474999999
                    // will transfer just the fee collected to CH -> burnt
                    await expect(clearingHouse.connect(alice).removeLiquidity(removeLiquidityParams))
                        .to.emit(exchange, "LiquidityChanged")
                        .withArgs(
                            alice.address,
                            baseToken.address,
                            quoteToken.address,
                            Number(lowerTick),
                            Number(upperTick),
                            "0",
                            "0",
                            "0",
                            parseEther("0.001135501474999999"),
                        )

                    // 10000 +  = 10000.001135501474999999
                    // atm alice's quote tokens should've been burnt and only the fees are left
                    expect(await clearingHouse.getOwedRealizedPnl(alice.address)).to.eq(
                        parseEther("0.001135501474999999"),
                    )

                    // 0.001135501474999999 * 2 ^ 128 = 3.863911296E35
                    const openOrder = await exchange.getOpenOrder(
                        alice.address,
                        baseToken.address,
                        lowerTick,
                        upperTick,
                    )
                    expect(openOrder).to.deep.eq([
                        liquidity,
                        Number(lowerTick), // lowerTick
                        Number(upperTick), // upperTick
                        // add the decimal point to prevent overflow, according to the following 10^18 comparison
                        // 386391129557376066102652522378417873
                        //                  1000000000000000000
                        parseEther("386391129557376066.102652522378417873"), // feeGrowthInsideClearingHouseLastX128
                        openOrder.lastTwPremiumGrowthInsideX96, // we don't verify the number here
                        openOrder.lastTwPremiumGrowthBelowX96, // we don't verify the number here
                        openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96, // we don't verify the number here
                    ])

                    // CH should have all bob's base token = 0.0007507052579
                    const baseTokenInfo = await clearingHouse.getTokenInfo(bob.address, baseToken.address)
                    expect(baseTokenInfo.available).be.closeTo(parseEther("0.000750705258114652"), 1)

                    // CH should have all alice's fee (quote token) = 0.1135501475 * 1% = 0.001135501475
                    // but all being settled to owedReliazedPnl (except a few rounding left)

                    // bob should have zero base token atm
                    // because bob swapped twice in the opposite directions with exact the same amount
                    const quoteTokenInfo = await clearingHouse.getTokenInfo(alice.address, quoteToken.address)
                    expect(quoteTokenInfo.available).be.eq(0)
                    expect(await clearingHouse.getOwedRealizedPnl(alice.address)).to.eq(
                        parseEther("0.001135501474999999"),
                    )
                })

                it("a trader swaps quote to base and then base to quote, thus the maker receives quote fee of two kinds", async () => {
                    const lowerTick = "50000"
                    const upperTick = "50200"

                    // add base liquidity
                    const addLiquidityParams = {
                        baseToken: baseToken.address,
                        lowerTick, // 148.3760629
                        upperTick, // 151.3733069
                        base: parseEther("0.000816820841"),
                        quote: "0",
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }
                    // will mint 0.000816820841 base -> transfer to pool
                    await clearingHouse.connect(alice).addLiquidity(addLiquidityParams)

                    // liquidity ~= 1
                    const liquidity = (
                        await exchange.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
                    ).liquidity

                    // bob swap
                    // quote: 0.112414646 / 0.99 = 0.1135501475
                    // quote fee in clearing house: 0.001135501475
                    // to base: 0.0007507052579
                    const swapParams1 = {
                        baseToken: baseToken.address,
                        isBaseToQuote: false,
                        isExactInput: true,
                        oppositeAmountBound: 0,
                        amount: parseEther("0.1135501475"),
                        sqrtPriceLimitX96: "0",
                    }
                    // will mint 0.1135501475 quote -> transfer 0.112414646 to pool
                    // will transfer 0.0007507052579 base from pool to CH
                    await clearingHouse.connect(bob).swap(swapParams1)

                    // bob swap
                    // base: 0.0007507052579
                    // B2QFee: CH actually shorts 0.0007507052579 / 0.99 = 0.0007582881393 and get 0.112414646 quote
                    // bob gets 0.112414646 * 0.99 = 0.1112904995
                    // base fee 0.0007582881393 * 0.01 = 0.000007582881393
                    const swapParams2 = {
                        baseToken: baseToken.address,
                        isBaseToQuote: true,
                        isExactInput: true,
                        oppositeAmountBound: 0,
                        amount: parseEther("0.000750705258114652"),
                        sqrtPriceLimitX96: "0",
                    }
                    // will transfer the existing 0.0007507052579 base to pool
                    // will transfer 0.112414646 quote from pool to CH
                    await clearingHouse.connect(bob).swap(swapParams2)

                    // alice remove liq 0, alice should collect fee
                    const removeLiquidityParams = {
                        baseToken: baseToken.address,
                        lowerTick,
                        upperTick,
                        liquidity: "0",
                        minBase: 0,
                        minQuote: 0,
                        deadline: ethers.constants.MaxUint256,
                    }

                    // B2QFee: expect 1% of quote = 0.00112414646
                    // Q2BFee: expect 1% of quote = 0.001135501475
                    // 0.00112414646 + 0.001135501475 = 0.002259647935
                    // will transfer and burnt all Uniswap fees collected
                    await expect(clearingHouse.connect(alice).removeLiquidity(removeLiquidityParams))
                        .to.emit(exchange, "LiquidityChanged")
                        .withArgs(
                            alice.address,
                            baseToken.address,
                            quoteToken.address,
                            Number(lowerTick),
                            Number(upperTick),
                            "0",
                            "0",
                            "0",
                            parseEther("0.002259647935249999"),
                        )

                    // no base fee
                    // 100 - 0.000816820841 = 99.9991831792
                    // alice haven't got back any of the 0.000816820841 she minted yet
                    expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                        parseEther("0"), // available
                        parseEther("0.000816820841"), // debt
                    ])

                    // alice received 0.002259647935 quote tokens as fee
                    expect(await clearingHouse.getOwedRealizedPnl(alice.address)).to.eq(
                        parseEther("0.002259647935249999"),
                    )

                    // feeGrowthInsideClearingHouseLastX128: 0.002259647934931506 * 2 ^ 128 = 7.689183477298074e+35
                    const openOrder = await exchange.getOpenOrder(
                        alice.address,
                        baseToken.address,
                        lowerTick,
                        upperTick,
                    )
                    expect(openOrder).to.deep.eq([
                        liquidity,
                        Number(lowerTick), // lowerTick
                        Number(upperTick), // upperTick
                        // add the decimal point to prevent overflow, according to the following 10^18 comparison
                        // 768918347819178371544278519533051567
                        //                  1000000000000000000
                        parseEther("768918347819178371.544278519533051567"), // feeGrowthInsideClearingHouseLastX128
                        openOrder.lastTwPremiumGrowthInsideX96, // we don't verify the number here
                        openOrder.lastTwPremiumGrowthBelowX96, // we don't verify the number here
                        openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96, // we don't verify the number here
                    ])

                    // bob should have zero base token atm
                    // because bob swapped twice in the opposite directions with exact the same amount
                    const baseTokenInfo = await clearingHouse.getTokenInfo(bob.address, baseToken.address)
                    expect(baseTokenInfo.available).be.eq(0)
                })
            })
        })

        // expect to have more tests
        describe("multi makers", () => {
            beforeEach(async () => {
                await pool.initialize(encodePriceSqrt(148.3760629, 1))
                // the initial number of oracle can be recorded is 1; thus, have to expand it
                await pool.increaseObservationCardinalityNext((2 ^ 16) - 1)

                // add pool after it's initialized
                await exchange.addPool(baseToken.address, 10000)
            })

            it("alice receives 3/4 of fee, while carol receives only 1/4", async () => {
                const lowerTick = "50000"
                const upperTick = "50200"
                const base = 0.000816820841

                // add base liquidity
                // 0.000816820841 * 3 = 0.002450462523
                const addLiquidityParamsAlice = {
                    baseToken: baseToken.address,
                    lowerTick, // 148.3760629
                    upperTick, // 151.3733069
                    base: parseEther((base * 3).toString()),
                    quote: "0",
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                }
                // will mint & transfer 0.002450462523 base to pool
                await clearingHouse.connect(alice).addLiquidity(addLiquidityParamsAlice)

                // add base liquidity
                const addLiquidityParamsCarol = {
                    baseToken: baseToken.address,
                    lowerTick, // 148.3760629
                    upperTick, // 151.3733069
                    base: parseEther(base.toString()),
                    quote: "0",
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                }
                // will mint & transfer 0.000816820841 base to pool
                await clearingHouse.connect(carol).addLiquidity(addLiquidityParamsCarol)

                // liquidity ~= 3
                const liquidityAlice = (
                    await exchange.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
                ).liquidity

                // liquidity ~= 1
                const liquidityCarol = (
                    await exchange.getOpenOrder(carol.address, baseToken.address, lowerTick, upperTick)
                ).liquidity

                // bob swap
                // quote: 0.112414646 / 0.99 = 0.1135501475
                // to base: 0.0007558893279
                const swapParams1 = {
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("0.1135501475"),
                    sqrtPriceLimitX96: "0",
                }
                // will mint 0.1135501475 & transfer 0.112414646 quote to pool
                // will receive 0.0007558893279 base from pool
                await clearingHouse.connect(bob).swap(swapParams1)

                // bob swap; note that he does not use all base he gets to swap into quote here
                // base: 0.0007507052579
                // B2QFee: CH actually shorts 0.0007507052579 / 0.99 = 0.0007582881393 and get 0.1116454419 quote
                // bob gets 0.1116454419 * 0.99 = 0.1105289875
                const swapParams2 = {
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("0.0007507052579"),
                    sqrtPriceLimitX96: "0",
                }
                // will transfer existing 0.0007507052579 base to pool
                // will receive 0.1116454419 quote from pool
                await clearingHouse.connect(bob).swap(swapParams2)

                // alice & carol both remove 0 liquidity; should both get fee
                const removeLiquidityParams = {
                    baseToken: baseToken.address,
                    lowerTick,
                    upperTick,
                    liquidity: "0",
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                }

                // B2QFee: expect 75% of 1% of quote in ClearingHouse = 0.001116454419 * 0.75 = 0.0008373408142
                // expect 75% of 1% of quote in Uniswap = 0.001135501475 * 0.75 = 0.0008516261063
                // 0.0008373408142 + 0.0008516261063 = 0.00168896692
                // will receive and burn base & quote tokens from pool (Uniswap fees)
                await expect(clearingHouse.connect(alice).removeLiquidity(removeLiquidityParams))
                    .to.emit(exchange, "LiquidityChanged")
                    .withArgs(
                        alice.address,
                        baseToken.address,
                        quoteToken.address,
                        Number(lowerTick),
                        Number(upperTick),
                        "0",
                        "0",
                        "0",
                        parseEther("0.001688966920907494"),
                    )

                // B2QFee: expect 25% of 1% of quote in ClearingHouse = 0.001116454419 * 0.25 = 0.0002791136048
                // expect 25% of 1% of quote = 0.001135501475 * 0.25 = 0.0002838753688
                // 0.0002791136048 + 0.0002838753688 = 0.0005629889736
                // will receive and burn base & quote tokens from pool (Uniswap fees)
                await expect(clearingHouse.connect(carol).removeLiquidity(removeLiquidityParams))
                    .to.emit(exchange, "LiquidityChanged")
                    .withArgs(
                        carol.address,
                        baseToken.address,
                        quoteToken.address,
                        Number(lowerTick),
                        Number(upperTick),
                        "0",
                        "0",
                        "0",
                        parseEther("0.000562988973635831"),
                    )

                // alice still has 0.002450462523 base debt
                expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                    parseEther("0"), // available
                    parseEther("0.002450462523"), // debt
                ])

                // alice has 0.00168896692 quote from fees
                expect(await clearingHouse.getOwedRealizedPnl(alice.address)).to.eq(parseEther("0.001688966920907494"))

                // carol still has 0.000816820841 base debt
                expect(await clearingHouse.getTokenInfo(carol.address, baseToken.address)).to.deep.eq([
                    parseEther("0"), // available
                    parseEther("0.000816820841"), // debt
                ])

                // carol has 0.0005629889737 quote from fees
                expect(await clearingHouse.getOwedRealizedPnl(carol.address)).to.eq(parseEther("0.000562988973635831"))

                // feeGrowthInsideClearingHouseLastX128: (0.001116454419 / 4) * 2 ^ 128 + (0.001135501474999999 / 4) * 2 ^ 128 = 1.9157522e35
                // 191575220500261126937834419214500538
                //                  1000000000000000000
                // add the decimal point to prevent overflow, according to the above 10^18 comparison
                const feeGrowthInsideClearingHouseLastX128 = parseEther("191575220500261126.937834419214500538")
                let openOrder = await exchange.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
                expect(openOrder).to.deep.eq([
                    liquidityAlice,
                    Number(lowerTick), // lowerTick
                    Number(upperTick), // upperTick
                    feeGrowthInsideClearingHouseLastX128,
                    openOrder.lastTwPremiumGrowthInsideX96, // we don't verify the number here
                    openOrder.lastTwPremiumGrowthBelowX96, // we don't verify the number here
                    openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96, // we don't verify the number here
                ])
                openOrder = await exchange.getOpenOrder(carol.address, baseToken.address, lowerTick, upperTick)
                expect(openOrder).to.deep.eq([
                    liquidityCarol,
                    Number(lowerTick), // lowerTick
                    Number(upperTick), // upperTick
                    feeGrowthInsideClearingHouseLastX128,
                    openOrder.lastTwPremiumGrowthInsideX96, // we don't verify the number here
                    openOrder.lastTwPremiumGrowthBelowX96, // we don't verify the number here
                    openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96, // we don't verify the number here
                ])

                const baseTokenInfo = await clearingHouse.getTokenInfo(bob.address, baseToken.address)
                expect(baseTokenInfo.available).be.closeTo(parseEther("0.000005184070208358"), 1)
                // CH should have alice's fee + carol's fee = 0.00168896692 + 0.0005629889737 = 0.002251955894
                // but they're all settled to their owedRelizedPnl so 0 with a few roundings left
                expect(await clearingHouse.getOwedRealizedPnl(alice.address)).to.eq(parseEther("0.001688966920907494"))
                expect(await clearingHouse.getOwedRealizedPnl(carol.address)).to.eq(parseEther("0.000562988973635831"))
            })

            it("out of maker's range; alice receives more fee as the price goes beyond carol's range", async () => {
                const lowerTick = "50000"
                const middleTick = "50200"
                const upperTick = "50400"
                const baseIn50000And50200 = 0.000816820841
                const baseIn50200And50400 = 0.0008086937422

                // Alice adds liquidity
                //   base: 0.000816820841 + 0.0008086937422 = 0.001625514583
                const addLiquidityParamsAlice = {
                    baseToken: baseToken.address,
                    lowerTick: lowerTick, // 148.3760629
                    upperTick: upperTick, // 154.4310961
                    base: parseEther((baseIn50000And50200 + baseIn50200And50400).toString()),
                    quote: "0",
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                }
                // will transfer 0.001625514583 base to pool
                await clearingHouse.connect(alice).addLiquidity(addLiquidityParamsAlice)

                // Carol adds liquidity
                //   base: 0.000816820841
                const addLiquidityParamsCarol = {
                    baseToken: baseToken.address,
                    lowerTick: lowerTick, // 148.3760629
                    upperTick: middleTick, // 151.3733069
                    base: parseEther(baseIn50000And50200.toString()),
                    quote: "0",
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                }
                // will transfer 0.000816820841 base to pool
                await clearingHouse.connect(carol).addLiquidity(addLiquidityParamsCarol)

                // total liquidity added:
                //   base: 0.001625514583 + 0.000816820841 = 0.002442335424

                // liquidity ~= 1
                const liquidityAlice = (
                    await exchange.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
                ).liquidity

                // liquidity ~= 1
                const liquidityCarol = (
                    await exchange.getOpenOrder(carol.address, baseToken.address, lowerTick, middleTick)
                ).liquidity

                // bob swap
                // quote amount in: (0.244829292 + 0.09891589745) / 0.99 = 0.3472173631
                //   range [50000, 50200):
                //     quote swapped in: 0.244829292
                //     base swapped out: 0.001633641682
                //     quote fee: 0.244829292 / 0.99 * 0.01 = 0.002473023152
                //   range [50200, 50400):
                //     quote swapped in: 0.09891589745
                //     base swapped out: 0.0006482449586
                //     quote fee: 0.09891589745 / 0.99 * 0.01 = 0.0009991504793
                //
                // base amount out (bob gets): 0.001633641682 + 0.0006482449586 = 0.002281886641
                const swapParams1 = {
                    baseToken: baseToken.address,
                    isBaseToQuote: false,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("0.3472173631"),
                    sqrtPriceLimitX96: "0",
                }
                // will mint 0.3472173631 and transfer 0.3437451895 quote to pool
                // will receive 0.002281886641 base from pool
                await clearingHouse.connect(bob).swap(swapParams1)

                // bob swap
                // base amount in: 0.00228188664 / 0.99 = 0.002304936
                //   range [50200, 50400):
                //     base swapped in: 0.0006482449586
                //     quote swapped out: 0.09891589745
                //     quote fee: 0.09891589745 * 0.01 = 0.0009891589745
                //   range [50000, 50200):
                //     base swapped in: 0.001633641682
                //     quote swapped out: 0.244829292
                //     quote fee: 0.244829292 * 0.01 = 0.00244829292
                //
                // quote amount out (bob gets): (0.09891589745 + 0.244829292) * 0.99 = 0.3403077376
                const swapParams2 = {
                    baseToken: baseToken.address,
                    isBaseToQuote: true,
                    isExactInput: true,
                    oppositeAmountBound: 0,
                    amount: parseEther("0.00228188664"),
                    sqrtPriceLimitX96: "0",
                }
                // will transfer existing 0.00228188664 base to pool
                // will receive 0.3437451895 quote from pool
                await clearingHouse.connect(bob).swap(swapParams2)

                // alice remove 0 liquidity; should get fee
                const removeLiquidityParamsAlice = {
                    baseToken: baseToken.address,
                    lowerTick: lowerTick,
                    upperTick: upperTick,
                    liquidity: "0",
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                }

                // alice's Q2B fee:
                //   expect 50% of 1% of quote in range (50000, 50200) in Uniswap = 0.244829292 / 0.99 * 0.5 * 0.01 = 0.001236511576
                //   expect 100% of 1% of quote in range (50200, 50400) in Uniswap = 0.09891589745 / 0.99 * 0.01 = 0.0009991504793
                //   sum: 0.001236511576 + 0.0009991504793 = 0.002235662055
                // alice's B2Q fee:
                //   expect 50% of 1% of quote in range [50000, 50200) in ClearingHouse = 0.00244829292 * 0.5 = 0.00122414646
                //   expect 100% of 1% of quote in range [50200, 50400) in ClearingHouse = 0.0009991504793 * 1 = 0.0009891589745
                //   sum: 0.00122414646 + 0.0009891589745 = 0.002213305435
                //
                // total quote fee: 0.002213305435 + 0.002235662055 = 0.00444896749
                // will receive and burn base & quote tokens from pool (Uniswap fees)
                await expect(clearingHouse.connect(alice).removeLiquidity(removeLiquidityParamsAlice))
                    .to.emit(exchange, "LiquidityChanged")
                    .withArgs(
                        alice.address,
                        baseToken.address,
                        quoteToken.address,
                        Number(lowerTick),
                        Number(upperTick),
                        "0",
                        "0",
                        "0",
                        parseEther("0.004448967489567409"),
                    )

                // carol remove 0 liquidity; should get fee
                const removeLiquidityParamsCarol = {
                    baseToken: baseToken.address,
                    lowerTick: lowerTick,
                    upperTick: middleTick,
                    liquidity: "0",
                    minBase: 0,
                    minQuote: 0,
                    deadline: ethers.constants.MaxUint256,
                }

                // carol's Q2B fee:
                //   expect 50% of 1% of quote in range (50000, 50200) in Uniswap = 0.244829292 / 0.99 * 0.5 * 0.01 = 0.001236511576
                // carol's B2Q fee:
                //   expect 50% of 1% of quote in range (50000, 50200) in ClearingHouse = 0.244829292 * 0.5 * 0.01 = 0.00122414646
                //
                // total quote fee: 0.00122414646 + 0.001236511576 = 0.002460658036
                // will receive and burn base & quote tokens from pool (Uniswap fees)
                await expect(clearingHouse.connect(carol).removeLiquidity(removeLiquidityParamsCarol))
                    .to.emit(exchange, "LiquidityChanged")
                    .withArgs(
                        carol.address,
                        baseToken.address,
                        quoteToken.address,
                        Number(lowerTick),
                        Number(middleTick),
                        "0",
                        "0",
                        "0",
                        parseEther("0.002460658034826347"),
                    )

                // alice still has 0.001625514583 base debt
                expect(await clearingHouse.getTokenInfo(alice.address, baseToken.address)).to.deep.eq([
                    parseEther("0"), // available
                    parseEther("0.001625514583200000"), // debt
                ])

                // alice has 0.00444896749 quote from fees
                expect(await clearingHouse.getOwedRealizedPnl(alice.address)).to.eq(parseEther("0.004448967489567409"))

                // carol still has 0.000816820841 base debt
                expect(await clearingHouse.getTokenInfo(carol.address, baseToken.address)).to.deep.eq([
                    parseEther("0"), // available
                    parseEther("0.000816820841"), // debt
                ])

                // carol has 0.002460658036 quote from fees
                expect(await clearingHouse.getOwedRealizedPnl(carol.address)).to.eq(parseEther("0.002460658034826347"))

                // when bob swap Q2B
                //   feeGrowthInsideClearingHouseLastX128 += (0.001236511576 + 0.0009991504793) * 2 ^ 128 = 7.607563758E35
                // when bob swap B2Q:
                //   feeGrowthInsideClearingHouseLastX128 += (0.0009891589745 + 0.00122414646) * 2 ^ 128 = 15.139051879E35
                let openOrder = await exchange.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick)
                expect(openOrder).to.deep.eq([
                    liquidityAlice,
                    Number(lowerTick), // lowerTick
                    Number(upperTick), // upperTick
                    parseEther("1513905187670593932.794783574578872579"),
                    openOrder.lastTwPremiumGrowthInsideX96, // we don't verify the number here
                    openOrder.lastTwPremiumGrowthBelowX96, // we don't verify the number here
                    openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96, // we don't verify the number here
                ])

                // when bob swap Q2B
                //   feeGrowthInsideClearingHouseLastX128 += 0.001236511576 * 2 ^ 128 = 4.207630858E35
                // when bob swap B2Q:
                //   feeGrowthInsideClearingHouseLastX128 += 0.00122414646 * 2 ^ 128 = 8.373185407E35
                openOrder = await exchange.getOpenOrder(carol.address, baseToken.address, lowerTick, middleTick)
                expect(openOrder).to.deep.eq([
                    liquidityCarol,
                    Number(lowerTick), // lowerTick
                    Number(middleTick), // upperTick
                    parseEther("837318540278413532.396943670424856473"),
                    openOrder.lastTwPremiumGrowthInsideX96, // we don't verify the number here
                    openOrder.lastTwPremiumGrowthBelowX96, // we don't verify the number here
                    openOrder.lastTwPremiumDivBySqrtPriceGrowthInsideX96, // we don't verify the number here
                ])

                // verify CH balances
                // CH should have a little base token left because bob did not swap back all his base token on swap #2
                const baseTokenInfo = await clearingHouse.getTokenInfo(bob.address, baseToken.address)
                expect(baseTokenInfo.available).be.closeTo(parseEther("0.000000000000873619"), 1)

                // CH should have both alice's and carol's fee = 0.00444896749 + 0.002460658036 = 0.006909625526
                // but they're all settled to their own owedRealizedPnl, so 0 balance left in CH
                {
                    const quoteTokenInfo = await clearingHouse.getTokenInfo(alice.address, quoteToken.address)
                    expect(quoteTokenInfo.available).be.eq(0)
                }
                {
                    const quoteTokenInfo = await clearingHouse.getTokenInfo(carol.address, quoteToken.address)
                    expect(quoteTokenInfo.available).be.eq(0)
                }
                expect(await clearingHouse.getOwedRealizedPnl(alice.address)).to.eq(parseEther("0.004448967489567409"))
                expect(await clearingHouse.getOwedRealizedPnl(carol.address)).to.eq(parseEther("0.002460658034826347"))
            })
        })
    })
})

// // === useful console.log for verifying stats ===
// console.log("alice stats:")
// console.log("base, available")
// console.log((await clearingHouse.getTokenInfo(alice.address, baseToken.address))[0].toString())
// console.log("base, debt")
// console.log((await clearingHouse.getTokenInfo(alice.address, baseToken.address))[1].toString())
// console.log("quote, available")
// console.log((await clearingHouse.getTokenInfo(alice.address, quoteToken.address))[0].toString())
// console.log("quote, debt")
// console.log((await clearingHouse.getTokenInfo(alice.address, quoteToken.address))[1].toString())

// console.log("----------------------")
// console.log("carol stats:")
// console.log("base, available")
// console.log((await clearingHouse.getTokenInfo(carol.address, baseToken.address))[0].toString())
// console.log("base, debt")
// console.log((await clearingHouse.getTokenInfo(carol.address, baseToken.address))[1].toString())
// console.log("quote, available")
// console.log((await clearingHouse.getTokenInfo(carol.address, quoteToken.address))[0].toString())
// console.log("quote, debt")
// console.log((await clearingHouse.getTokenInfo(carol.address, quoteToken.address))[1].toString())

// console.log("----------------------")
// console.log("feeGrowthInsideClearingHouseLastX128 carol 50000 - 50200")
// console.log((await exchange.getOpenOrder(carol.address, baseToken.address, lowerTick, middleTick))[3].toString())
// console.log("feeGrowthInsideUniswapLastX128 carol 50000 - 50200")
// console.log((await exchange.getOpenOrder(carol.address, baseToken.address, lowerTick, middleTick))[4].toString())
// console.log("feeGrowthInsideClearingHouseLastX128 alice 50000 - 50400")
// console.log((await exchange.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick))[3].toString())
// console.log("feeGrowthInsideUniswapLastX128 alice 50000 - 50400")
// console.log((await exchange.getOpenOrder(alice.address, baseToken.address, lowerTick, upperTick))[4].toString())

// console.log("----------------------")
// console.log("base diff")
// console.log(baseBefore.sub(await baseToken.balanceOf(clearingHouse.address)).toString())
// console.log("quote diff")
// console.log(quoteBefore.sub(await quoteToken.balanceOf(clearingHouse.address)).toString())
// // === useful console.log for verifying stats ===
