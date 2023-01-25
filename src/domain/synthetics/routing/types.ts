import { BigNumber } from "ethers";
import { MarketsData } from "../markets";

export type Edge = {
  marketAddress: string;
  // from token
  from: string;
  // to token
  to: string;
};

export type MarketsGraph = {
  abjacencyList: { [token: string]: Edge[] };
  edges: Edge[];
  marketsData: MarketsData;
};

/**
 * returns amountOut in usd
 */
export type SwapEstimator = (e: Edge, usdIn: BigNumber) => BigNumber;
