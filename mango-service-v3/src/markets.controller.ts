import {
  getAllMarkets,
  getTokenBySymbol,
  MarketConfig,
  PerpMarket,
} from "@blockworks-foundation/mango-client";
import { Market } from "@project-serum/serum";
import { PublicKey } from "@solana/web3.js";
import Big from "big.js";
import { BadRequestError, RequestErrorCustom } from "dtos";
import { NextFunction, Request, Response, Router } from "express";
import { param, query, validationResult } from "express-validator";
import { OrderInfo } from "types";
import Controller from "./controller.interface";
import MangoSimpleClient from "./mango.simple.client";
import {
  isValidMarket,
  logger,
  patchExternalMarketName,
  patchInternalMarketName,
} from "./utils";
import axios from "axios";

class MarketsController implements Controller {
  public path = "/api/markets";
  public router = Router();

  constructor(public mangoSimpleClient: MangoSimpleClient) {
    this.initializeRoutes();
  }

  private initializeRoutes() {
    // GET /markets
    this.router.get(this.path, this.fetchMarkets);

    // GET /markets/{market_name}
    this.router.get(
      `${this.path}/:market_name`,
      param("market_name").custom(isValidMarket),
      this.fetchMarket
    );

    // GET /markets/{market_name}/orderbook?depth={depth}
    this.router.get(
      `${this.path}/:market_name/orderbook`,
      param("market_name").custom(isValidMarket),
      query("depth", "Depth should be a number between 20 and 100!")
        .optional()
        .isInt({ max: 100, min: 20 }),
      this.getOrderBook
    );

    // GET /markets/{market_name}/trades
    this.router.get(
      `${this.path}/:market_name/trades`,
      param("market_name").custom(isValidMarket),
      this.getTrades
    );

    // GET /markets/{market_name}/candles?resolution={resolution}&start_time={start_time}&end_time={end_time}
    this.router.get(
      `${this.path}/:market_name/candles`,
      param("market_name").custom(isValidMarket),
      this.getCandles
    );
  }

  private fetchMarkets = async (
    request: Request,
    response: Response,
    next: NextFunction
  ) => {
    this.fetchMarketsInternal()
      .then((marketsDto) => {
        response.send({
          success: true,
          result: marketsDto,
        } as MarketsDto);
      })
      .catch((error) => {
        logger.error(`message - ${error.message}, ${error.stack}`);
        return response.status(500).send({
          errors: [{ msg: error.message } as RequestErrorCustom],
        });
      });
  };

  private fetchMarket = async (
    request: Request,
    response: Response,
    next: NextFunction
  ) => {
    const errors = validationResult(request);
    if (!errors.isEmpty()) {
      return response
        .status(400)
        .json({ errors: errors.array() as BadRequestError[] });
    }

    const marketName = patchExternalMarketName(request.params.market_name);

    this.fetchMarketsInternal(marketName)
      .then((marketsDto) => {
        response.send({
          success: true,
          result: marketsDto,
        } as MarketsDto);
      })
      .catch((error) => {
        logger.error(`message - ${error.message}, ${error.stack}`);
        return response.status(500).send({
          errors: [{ msg: error.message } as RequestErrorCustom],
        });
      });
  };

  private async fetchMarketsInternal(
    marketName?: string
  ): Promise<MarketDto[]> {
    let allMarketConfigs = getAllMarkets(
      this.mangoSimpleClient.mangoGroupConfig
    );

    if (marketName !== undefined) {
      allMarketConfigs = allMarketConfigs.filter(
        (marketConfig) => marketConfig.name === marketName
      );
    }

    const allMarkets = await this.mangoSimpleClient.fetchAllMarkets(marketName);

    return Promise.all(
      allMarketConfigs.map((marketConfig) =>
        this.computeMarketLatestDetails(marketConfig, allMarkets)
      )
    );
  }

  private async computeMarketLatestDetails(
    marketConfig: MarketConfig,
    allMarkets: Partial<Record<string, Market | PerpMarket>>
  ): Promise<MarketDto> {
    const market = allMarkets[marketConfig.publicKey.toBase58()];

    const [
      marketData, // contains volume, 1H, 24H, bod changes
      ordersInfo, // used for latest bid+ask
      tradesResponse, // used for latest trade+price
    ] = await Promise.all([
      getMarketData(marketConfig),
      (await this.mangoSimpleClient.fetchAllBidsAndAsks(
        false,
        marketConfig.name
      )) as OrderInfo[][],
      axios.get(
        `https://event-history-api-candles.herokuapp.com/trades/address/${marketConfig.publicKey.toBase58()}`
      ),
    ]);

    // latest bid+ask
    const bids = ordersInfo
      .flat()
      .filter((orderInfo) => orderInfo.order.side === "buy")
      .sort((b1, b2) => b2.order.price - b1.order.price);
    const asks = ordersInfo
      .flat()
      .filter((orderInfo) => orderInfo.order.side === "sell")
      .sort((a1, a2) => a1.order.price - a2.order.price);

    // latest trade+price
    const parsedTradesResponse = (await tradesResponse.data) as any;
    const lastPrice =
      "s" in parsedTradesResponse && parsedTradesResponse["s"] === "error"
        ? null
        : parsedTradesResponse["data"][0]["price"];

    // size increments
    let minOrderSize;
    if (market instanceof Market && market.minOrderSize) {
      minOrderSize = market.minOrderSize;
    } else if (market instanceof PerpMarket) {
      const baseDecimals = market.baseDecimals;
      minOrderSize = new Big(market.baseLotSize.toString())
        .div(new Big(10).pow(baseDecimals))
        .toNumber();
    }

    // price increment
    let tickSize = 1;
    if (market instanceof Market) {
      tickSize = market.tickSize;
    } else if (market instanceof PerpMarket) {
      const baseDecimals = market.baseDecimals;

      const quoteDecimals = getTokenBySymbol(
        this.mangoSimpleClient.mangoGroupConfig,
        this.mangoSimpleClient.mangoGroupConfig.quoteSymbol
      ).decimals;

      const nativeToUi = new Big(10).pow(baseDecimals - quoteDecimals);
      const lotsToNative = new Big(market.quoteLotSize.toString()).div(
        new Big(market.baseLotSize.toString())
      );
      tickSize = lotsToNative.mul(nativeToUi).toNumber();
    }

    return {
      name: patchInternalMarketName(marketConfig.name),
      baseCurrency: marketConfig.baseSymbol,
      quoteCurrency: "USDC",
      // note: event-history-api doesn't index volume for spot
      quoteVolume24h:
        marketData.quoteVolume24h !== 0 ? marketData.quoteVolume24h : undefined,
      change1h: marketData.change1h,
      change24h: marketData.change24h,
      changeBod: marketData.changeBod,
      highLeverageFeeExempt: undefined,
      minProvideSize: undefined,
      type: marketConfig.name.includes("PERP") ? "futures" : "spot",
      underlying: marketConfig.baseSymbol,
      enabled: undefined,
      ask: asks.length > 0 ? asks[0].order.price : null,
      bid: bids.length > 0 ? bids[0].order.price : null,
      last: lastPrice,
      postOnly: undefined,
      price: lastPrice,
      priceIncrement: tickSize,
      sizeIncrement: minOrderSize,
      restricted: undefined,
      // note: event-history-api doesn't index volume for spot
      volumeUsd24h:
        marketData.volumeUsd24h !== 0 ? marketData.volumeUsd24h : undefined,
    } as MarketDto;
  }

  private getOrderBook = async (
    request: Request,
    response: Response,
    next: NextFunction
  ) => {
    const errors = validationResult(request);
    if (!errors.isEmpty()) {
      return response
        .status(400)
        .json({ errors: errors.array() as BadRequestError[] });
    }

    const marketName = patchExternalMarketName(request.params.market_name);
    const depth = Number(request.query.depth) || 20;

    this.getOrderBookInternal(marketName, depth)
      .then(({ asks, bids }) => {
        return response.send({
          success: true,
          result: {
            asks: asks,
            bids: bids,
          },
        });
      })
      .catch((error) => {
        logger.error(`message - ${error.message}, ${error.stack}`);
        return response.status(500).send({
          errors: [{ msg: error.message } as RequestErrorCustom],
        });
      });
  };

  private async getOrderBookInternal(marketName: string, depth: number) {
    const ordersInfo = await this.mangoSimpleClient.fetchAllBidsAndAsks(
      false,
      marketName
    );
    const bids_ = ordersInfo
      .flat()
      .filter((orderInfo) => orderInfo.order.side === "buy")
      .sort((b1, b2) => b2.order.price - b1.order.price);
    const asks_ = ordersInfo
      .flat()
      .filter((orderInfo) => orderInfo.order.side === "sell")
      .sort((a1, a2) => a1.order.price - a2.order.price);

    const asks = asks_
      .slice(0, depth)
      .map((ask) => [ask.order.price, ask.order.size]);

    const bids = bids_
      .slice(0, depth)
      .map((bid) => [bid.order.price, bid.order.size]);
    return { asks, bids };
  }

  private getTrades = async (
    request: Request,
    response: Response,
    next: NextFunction
  ) => {
    const errors = validationResult(request);
    if (!errors.isEmpty()) {
      return response
        .status(400)
        .json({ errors: errors.array() as BadRequestError[] });
    }

    const allMarketConfigs = getAllMarkets(
      this.mangoSimpleClient.mangoGroupConfig
    );
    const marketName = patchExternalMarketName(request.params.market_name);
    const marketPk = allMarketConfigs.filter(
      (marketConfig) => marketConfig.name === marketName
    )[0].publicKey;

    this.getTradesInternal(marketPk)
      .then((tradeDtos) => {
        return response.send({
          success: true,
          result: tradeDtos,
        });
      })
      .catch((error) => {
        logger.error(`message - ${error.message}, ${error.stack}`);
        return response.status(500).send({
          errors: [{ msg: error.message } as RequestErrorCustom],
        });
      });
  };

  private async getTradesInternal(marketPk: PublicKey) {
    const tradesResponse = await axios.get(
      `https://event-history-api-candles.herokuapp.com/trades/address/${marketPk.toBase58()}`
    );
    const parsedTradesResponse = (await tradesResponse.data) as any;
    if ("s" in parsedTradesResponse && parsedTradesResponse["s"] === "error") {
      return [];
    }
    return parsedTradesResponse["data"].map((trade: any) => {
      return {
        id: trade["orderId"],
        liquidation: undefined,
        price: trade["price"],
        side: trade["side"],
        size: trade["size"],
        time: new Date(trade["time"]),
      } as TradeDto;
    });
  }

  private getCandles = async (
    request: Request,
    response: Response,
    next: NextFunction
  ) => {
    const errors = validationResult(request);
    if (!errors.isEmpty()) {
      return response
        .status(400)
        .json({ errors: errors.array() as BadRequestError[] });
    }

    const marketName = patchExternalMarketName(request.params.market_name);
    const resolution = String(request.query.resolution);
    const fromEpochS = Number(request.query.start_time);
    const toEpochS = Number(request.query.end_time);

    await getOhlcv(marketName, resolution, fromEpochS, toEpochS, false)
      .then(({ t, o, h, l, c, v }) => {
        const ohlcvDtos: OhlcvDto[] = [];
        for (let i = 0; i < t.length; i++) {
          ohlcvDtos.push({
            time: t[i],
            open: o[i],
            high: h[i],
            low: l[i],
            close: c[i],
            volume: v[i],
          } as OhlcvDto);
        }
        return response.send({
          success: true,
          result: ohlcvDtos,
        });
      })
      .catch((error) => {
        logger.error(`message - ${error.message}, ${error.stack}`);
        return response.status(500).send({
          errors: [{ msg: error.message } as RequestErrorCustom],
        });
      });
  };
}

export default MarketsController;

/// helper functions

async function getMarketData(
  marketConfig: MarketConfig
): Promise<Partial<MarketDto>> {
  const marketDataResponse = await axios.get(
    `https://event-history-api-candles.herokuapp.com/markets/` +
      `${patchInternalMarketName(marketConfig.name)}`
  );
  return marketDataResponse.data;
}

async function getOhlcv(
  market: string,
  resolution: string,
  fromS: number,
  toS: number,
  forceMinimumMinuteResolution: boolean = true
) {
  // to leverage caching on backend,
  // and not spam with requests having ms resolution,
  // force minimum resolution to a minute
  if (forceMinimumMinuteResolution) {
    fromS = Math.floor(fromS / 60) * 60;
    toS = Math.floor(toS / 60) * 60;
  }
  const fromSFixed = fromS.toFixed();
  const toSFixed = toS.toFixed();
  const historyResponse = await axios.get(
    `https://event-history-api-candles.herokuapp.com/tv/history` +
      `?symbol=${market}&resolution=${resolution}&from=${fromSFixed}&to=${toSFixed}`
  );
  return historyResponse.data;
}

/// Dtos

// e.g.
// {
//   "success": true,
//   "result": [
//     {
//       "name": "BTC-0628",
//       "baseCurrency": null,
//       "quoteCurrency": null,
//       "quoteVolume24h": 28914.76,
//       "change1h": 0.012,
//       "change24h": 0.0299,
//       "changeBod": 0.0156,
//       "highLeverageFeeExempt": false,
//       "minProvideSize": 0.001,
//       "type": "future",
//       "underlying": "BTC",
//       "enabled": true,
//       "ask": 3949.25,
//       "bid": 3949,
//       "last": 3949.00,
//       "postOnly": false,
//       "price": 10579.52,
//       "priceIncrement": 0.25,
//       "sizeIncrement": 0.0001,
//       "restricted": false,
//       "volumeUsd24h": 28914.76
//     }
//   ]
// }

interface MarketsDto {
  success: boolean;
  result: MarketDto[];
}

interface MarketDto {
  name: string;
  baseCurrency: string;
  quoteCurrency: string;
  quoteVolume24h: number;
  change1h: number;
  change24h: number;
  changeBod: number;
  highLeverageFeeExempt: boolean;
  minProvideSize: number;
  type: string;
  underlying: string;
  enabled: boolean;
  ask: number;
  bid: number;
  last: number;
  postOnly: boolean;
  price: number;
  priceIncrement: number;
  sizeIncrement: number;
  restricted: boolean;
  volumeUsd24h: number;
}

// e.g.
// {
//   "success": true,
//   "result": {
//     "asks": [
//       [
//         4114.25,
//         6.263
//       ]
//     ],
//     "bids": [
//       [
//         4112.25,
//         49.29
//       ]
//     ]
//   }
// }
interface OrdersDto {
  success: boolean;
  result: {
    asks: number[][];
    bids: number[][];
  };
}

// e.g.
// {
//   "success": true,
//   "result": [
//     {
//       "id": 3855995,
//       "liquidation": false,
//       "price": 3857.75,
//       "side": "buy",
//       "size": 0.111,
//       "time": "2019-03-20T18:16:23.397991+00:00"
//     }
//   ]
// }

interface TradesDto {
  success: boolean;
  result: TradeDto[];
}

interface TradeDto {
  id: string;
  liquidation: boolean;
  price: number;
  side: string;
  size: number;
  time: Date;
}

// e.g.
// {
//   "success": true,
//   "result": [
//     {
//       "close": 11055.25,
//       "high": 11089.0,
//       "low": 11043.5,
//       "open": 11059.25,
//       "startTime": "2019-06-24T17:15:00+00:00",
//       "volume": 464193.95725
//     }
//   ]
// }

interface OhlcvsDto {
  success: boolean;
  result: OhlcvDto[];
}

interface OhlcvDto {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
