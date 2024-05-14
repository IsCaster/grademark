import { ITrade } from "./trade";
import { IDataFrame, DataFrame } from "data-forge";
import { IStrategy, IBar, IPosition } from "..";
import { assert } from "chai";
import { IEnterPositionOptions, TradeDirection } from "./strategy";
import { isObject } from "./utils";
const CBuffer = require("CBuffer");

/**
 * Update an open position for a new bar at the start time of this bar
 *
 * @param position The position to update.
 * @param bar The current bar.
 */
function updatePosition(position: IPosition, bar: IBar): void {
    const price = bar.open;
    const lastGrowth = position.growth;
    position.profit = position.direction === TradeDirection.Long ? price - position.entryPrice : position.entryPrice - price;
    position.profitPct = (position.profit / position.entryPrice) * 100;
    position.growth = position.direction === TradeDirection.Long ? price / position.entryPrice : (position.entryPrice * 2 - price) / position.entryPrice;
    if (position.curStopPrice !== undefined) {
        const unitRisk = position.direction === TradeDirection.Long ? price - position.curStopPrice : position.curStopPrice - price;
        position.curRiskPct = (unitRisk / price) * 100;
        position.curRMultiple = position.profit / unitRisk;
    }
    position.holdingPeriod += 1;
    position.curRateOfReturn = position.growth / lastGrowth - 1;
}

/**
 * Close a position that has been exited and produce a trade.
 *
 * @param position The position to close.
 * @param exitTime The timestamp for the bar when the position was exited.
 * @param exitPrice The price of the instrument when the position was exited.
 */
function finalizePosition(position: IPosition, exitTime: Date, exitPrice: number, exitReason: string, fees: number): ITrade {
    const profit = position.direction === TradeDirection.Long ? exitPrice - position.entryPrice : position.entryPrice - exitPrice;
    let rmultiple;
    if (position.initialUnitRisk !== undefined) {
        rmultiple = profit / position.initialUnitRisk;
    }
    const lastGrowth = position.growth;
    const growth = position.direction === TradeDirection.Long ? exitPrice / position.entryPrice : (position.entryPrice * 2 - exitPrice) / position.entryPrice;
    position.growth = growth - growth * fees;
    position.holdingPeriod += 1;
    position.curRateOfReturn = position.growth / lastGrowth - 1;
    if (position.rateOfReturnSeries instanceof Array) {
        position.rateOfReturnSeries.push({
            time: exitTime,
            value: position.curRateOfReturn,
        });
    }
    return {
        direction: position.direction,
        entryTime: position.entryTime,
        entryPrice: position.entryPrice,
        exitTime: exitTime,
        exitPrice: exitPrice,
        profit: profit,
        profitPct: (profit / position.entryPrice) * 100,
        growth: position.growth,
        riskPct: position.initialRiskPct,
        riskSeries: position.riskSeries,
        rateOfReturnSeries: position.rateOfReturnSeries,
        rmultiple: rmultiple,
        holdingPeriod: position.holdingPeriod,
        exitReason: exitReason,
        stopPrice: position.curStopPrice,
        stopPriceSeries: position.stopPriceSeries,
        profitTarget: position.profitTarget,
        runUp: position.runUp,
    };
}

enum PositionStatus { // Tracks the state of the position across the trading period.
    None,
    Enter,
    Position,
    Exit,
}

/**
 * Options to the backtest function.
 */
export interface IBacktestOptions {
    /**
     * Enable recording of the stop price over the holding period of each trade.
     * It can be useful to enable this and visualize the stop loss over time.
     */
    recordStopPrice?: boolean;

    /**
     * Enable recording of the risk over the holding period of each trade.
     * It can be useful to enable this and visualize the risk over time.
     */
    recordRisk?: boolean;

    recordRateOfReturn?: boolean;
}

/**
 * Backtest a trading strategy against a data series and generate a sequence of trades.
 */
export function backtest<InputBarT extends IBar, IndicatorBarT extends InputBarT, ParametersT, IndexT>(
    strategy: IStrategy<InputBarT, IndicatorBarT, ParametersT, IndexT>,
    inputSeries: IDataFrame<IndexT, InputBarT>,
    options?: IBacktestOptions
): ITrade[] {
    if (!isObject(strategy)) {
        throw new Error("Expected 'strategy' argument to 'backtest' to be an object that defines the trading strategy to backtest.");
    }

    if (!isObject(inputSeries) && inputSeries.count() > 0) {
        throw new Error("Expected 'inputSeries' argument to 'backtest' to be a Data-Forge DataFrame that contains historical input data for backtesting.");
    }

    if (!options) {
        options = {};
    }

    if (inputSeries.none()) {
        throw new Error("Expect input data series to contain at last 1 bar.");
    }

    const lookbackPeriod = strategy.lookbackPeriod || 1;
    if (inputSeries.count() < lookbackPeriod) {
        throw new Error("You have less input data than your lookback period, the size of your input data should be some multiple of your lookback period.");
    }

    const timeframe = Math.round((inputSeries.last().time.getTime() - inputSeries.first().time.getTime()) / inputSeries.count());

    const strategyParameters = strategy.parameters || ({} as ParametersT);

    let indicatorsSeries: IDataFrame<IndexT, IndicatorBarT>;

    //
    // Prepare indicators.
    //
    if (strategy.prepIndicators) {
        indicatorsSeries = strategy.prepIndicators({
            parameters: strategyParameters,
            inputSeries: inputSeries,
        });
    } else {
        indicatorsSeries = inputSeries as IDataFrame<IndexT, IndicatorBarT>;
    }

    //
    // Sum of maker fee and taker fee.
    //
    const fees = (strategy.fees && strategy.fees()) || 0;

    //
    // Tracks trades that have been closed.
    //
    const completedTrades: ITrade[] = [];

    //
    // Status of the position at any give time.
    //
    let positionStatus: PositionStatus = PositionStatus.None;

    let exitPrice: number | undefined;

    let exitReason: string | undefined;
    //
    // Records the direction of a position/trade.
    //
    let positionDirection: TradeDirection = TradeDirection.Long;

    //
    // Tracks the currently open position, or set to null when there is no open position.
    //
    let openPosition: IPosition | null = null;

    //
    // Create a circular buffer to use for the lookback.
    //
    const lookbackBuffer = new CBuffer(lookbackPeriod);

    /**
     * User calls this function to enter a position on the instrument.
     */
    function enterPosition(options?: IEnterPositionOptions) {
        assert(positionStatus === PositionStatus.None, "Can only enter a position when not already in one.");

        positionStatus = PositionStatus.Enter; // Enter position next bar.
        positionDirection = (options && options.direction) || TradeDirection.Long;
    }

    /**
     * User calls this function to exit a position on the instrument.
     */
    function exitPosition(price?: number, reason?: string) {
        assert(positionStatus === PositionStatus.Position, "Can only exit a position when we are in a position.");

        positionStatus = PositionStatus.Exit; // Exit position next bar.
        exitPrice = price;
        exitReason = reason;
    }

    //
    // Close the current open position.
    //
    function closePosition(bar: InputBarT, price: number, reason: string) {
        const trade = finalizePosition(openPosition!, bar.time, price, reason, fees);
        completedTrades.push(trade!);
        // Reset to no open position;
        openPosition = null;
        positionStatus = PositionStatus.None;
        exitPrice = undefined;
        exitReason = undefined;
    }

    function exitOnCondition(bar: IndicatorBarT) {
        assert(openPosition !== null, "Expected open position to already be initialised!");
        if (openPosition!.curStopPrice !== undefined) {
            if (openPosition!.direction === TradeDirection.Long) {
                if (bar.low <= openPosition!.curStopPrice!) {
                    // Exit intrabar due to stop loss.
                    exitPosition(Math.min(openPosition!.curStopPrice!, bar.open), "stop-loss");
                    return;
                }
            } else {
                if (bar.high >= openPosition!.curStopPrice!) {
                    // Exit intrabar due to stop loss.
                    exitPosition(Math.max(openPosition!.curStopPrice!, bar.open), "stop-loss");
                    return;
                }
            }
        }

        if (openPosition!.profitTarget !== undefined) {
            if (openPosition!.direction === TradeDirection.Long) {
                if (bar.high >= openPosition!.profitTarget!) {
                    // Exit intrabar due to profit target.
                    exitPosition(openPosition!.profitTarget!, "profit-target");
                    return;
                }
            } else {
                if (bar.low <= openPosition!.profitTarget!) {
                    // Exit intrabar due to profit target.
                    exitPosition(openPosition!.profitTarget!, "profit-target");
                    return;
                }
            }
        }

        if (strategy.exitRule) {
            strategy.exitRule(exitPosition, {
                entryPrice: openPosition!.entryPrice,
                position: openPosition!,
                bar: bar,
                lookback: new DataFrame<number, IndicatorBarT>(lookbackBuffer.data),
                parameters: strategyParameters,
            });
        }
    }

    for (const bar of indicatorsSeries) {
        lookbackBuffer.push(bar);

        if (lookbackBuffer.length < lookbackPeriod) {
            continue; // Don't invoke rules until lookback period is satisfied.
        }

        switch (
            +positionStatus //TODO: + is a work around for TS switch stmt with enum.
        ) {
            case PositionStatus.None:
                strategy.entryRule(enterPosition, {
                    bar: bar,
                    lookback: new DataFrame<number, IndicatorBarT>(lookbackBuffer.data),
                    parameters: strategyParameters,
                });
                break;

            case PositionStatus.Enter:
                assert(openPosition === null, "Expected there to be no open position initialised yet!");

                const entryPrice = bar.open;

                openPosition = {
                    direction: positionDirection,
                    entryTime: bar.time,
                    entryPrice: entryPrice,
                    growth: 1,
                    profit: 0,
                    profitPct: 0,
                    holdingPeriod: 0,
                    curRateOfReturn: 0,
                    runUp: 0,
                };

                if (strategy.stopLoss) {
                    const initialStopDistance = strategy.stopLoss({
                        entryPrice: entryPrice,
                        position: openPosition,
                        bar: bar,
                        lookback: new DataFrame<number, InputBarT>(lookbackBuffer.data),
                        parameters: strategyParameters,
                    });
                    openPosition.initialStopPrice = openPosition.direction === TradeDirection.Long ? entryPrice - initialStopDistance : entryPrice + initialStopDistance;
                    openPosition.curStopPrice = openPosition.initialStopPrice;
                }

                if (openPosition.curStopPrice !== undefined) {
                    openPosition.initialUnitRisk = openPosition.direction === TradeDirection.Long ? entryPrice - openPosition.curStopPrice : openPosition.curStopPrice - entryPrice;
                    openPosition.initialRiskPct = (openPosition.initialUnitRisk / entryPrice) * 100;
                    openPosition.curRiskPct = openPosition.initialRiskPct;
                    openPosition.curRMultiple = 0;

                    if (options.recordRisk) {
                        openPosition.riskSeries = [
                            {
                                time: bar.time,
                                value: openPosition.curRiskPct,
                            },
                        ];
                    }
                }

                if (options.recordRateOfReturn) {
                    openPosition.rateOfReturnSeries = [];
                }

                if (strategy.profitTarget) {
                    const profitDistance = strategy.profitTarget({
                        entryPrice: entryPrice,
                        position: openPosition,
                        bar: bar,
                        lookback: new DataFrame<number, InputBarT>(lookbackBuffer.data),
                        parameters: strategyParameters,
                    });
                    openPosition.profitTarget = openPosition.direction === TradeDirection.Long ? entryPrice + profitDistance : entryPrice - profitDistance;
                }

                positionStatus = PositionStatus.Position;

                // check the first bar
                exitOnCondition(bar);

                if (strategy.trailingStopLoss) {
                    const trailingStopDistance = strategy.trailingStopLoss({
                        entryPrice: entryPrice,
                        position: openPosition,
                        bar: bar,
                        lookback: new DataFrame<number, InputBarT>(lookbackBuffer.data),
                        parameters: strategyParameters,
                    });
                    const trailingStopPrice = openPosition.direction === TradeDirection.Long ? bar.close - trailingStopDistance : bar.close + trailingStopDistance;
                    if (openPosition.initialStopPrice === undefined) {
                        openPosition.curStopPrice = trailingStopPrice;
                    } else {
                        openPosition.initialStopPrice =
                            openPosition.direction === TradeDirection.Long ? Math.max(openPosition.initialStopPrice, trailingStopPrice) : Math.min(openPosition.initialStopPrice, trailingStopPrice);
                        openPosition.curStopPrice = openPosition.initialStopPrice;
                    }

                    if (options.recordStopPrice) {
                        openPosition.stopPriceSeries = [
                            {
                                time: bar.time,
                                value: openPosition.curStopPrice,
                            },
                        ];
                    }
                }

                if (openPosition.direction === TradeDirection.Long) {
                    openPosition!.runUp = bar.high - openPosition!.entryPrice > openPosition!.runUp! ? bar.high - openPosition!.entryPrice : openPosition!.runUp;
                } else {
                    openPosition!.runUp = openPosition!.entryPrice - bar.low > openPosition!.runUp! ? openPosition!.entryPrice - bar.low : openPosition!.runUp;
                }
                break;

            case PositionStatus.Position:
                assert(openPosition !== null, "Expected open position to already be initialised!");

                updatePosition(openPosition!, bar);
                if (openPosition!.curRiskPct !== undefined && options.recordRisk) {
                    // This risk pecent is calculated at the start time of current bar
                    openPosition!.riskSeries!.push({
                        time: bar.time,
                        value: openPosition!.curRiskPct!,
                    });
                }

                if (options.recordRateOfReturn) {
                    openPosition!.rateOfReturnSeries!.push({
                        time: bar.time,
                        value: openPosition!.curRateOfReturn!,
                    });
                }

                exitOnCondition(bar);

                if (strategy.trailingStopLoss !== undefined) {
                    //
                    // Revaluate trailing stop loss.
                    //
                    const trailingStopDistance = strategy.trailingStopLoss({
                        entryPrice: openPosition!.entryPrice,
                        position: openPosition!,
                        bar: bar,
                        lookback: new DataFrame<number, InputBarT>(lookbackBuffer.data),
                        parameters: strategyParameters,
                    });

                    if (openPosition!.direction === TradeDirection.Long) {
                        const newTrailingStopPrice = bar.close - trailingStopDistance;
                        openPosition!.curStopPrice = openPosition!.initialStopPrice ? Math.max(openPosition!.initialStopPrice!, newTrailingStopPrice) : newTrailingStopPrice;
                    } else {
                        const newTrailingStopPrice = bar.close + trailingStopDistance;
                        openPosition!.curStopPrice = openPosition!.initialStopPrice ? Math.min(openPosition!.initialStopPrice!, newTrailingStopPrice) : newTrailingStopPrice;
                    }

                    if (options.recordStopPrice) {
                        // This stop price is used for next bar
                        openPosition!.stopPriceSeries!.push({
                            time: bar.time,
                            value: openPosition!.curStopPrice!,
                        });
                    }
                }
                if (openPosition!.direction === TradeDirection.Long) {
                    openPosition!.runUp = bar.high - openPosition!.entryPrice > openPosition!.runUp! ? bar.high - openPosition!.entryPrice : openPosition!.runUp;
                } else {
                    openPosition!.runUp = openPosition!.entryPrice - bar.low > openPosition!.runUp! ? openPosition!.entryPrice - bar.low : openPosition!.runUp;
                }
                break;

            case PositionStatus.Exit:
                assert(openPosition !== null, "Expected open position to already be initialised!");

                closePosition(bar, exitPrice ?? bar.open, exitReason ?? "exit-rule");
                break;

            default:
                throw new Error("Unexpected state!");
        }
    }

    if (openPosition) {
        // Finalize open position.
        const lastBar = indicatorsSeries.last();
        const lastTrade = finalizePosition(openPosition, new Date(lastBar.time.getTime() + timeframe), lastBar.close, "finalize", fees);
        completedTrades.push(lastTrade);
    }

    return completedTrades;
}
