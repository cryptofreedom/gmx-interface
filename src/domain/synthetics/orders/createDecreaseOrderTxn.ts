import { Web3Provider } from "@ethersproject/providers";
import { t } from "@lingui/macro";
import ExchangeRouter from "abis/ExchangeRouter.json";
import { getContract } from "config/contracts";
import { NATIVE_TOKEN_ADDRESS, convertTokenAddress } from "config/tokens";
import { encodeReferralCode } from "domain/referrals";
import { BigNumber, ethers } from "ethers";
import { callContract } from "lib/contracts";
import { TokensData, convertToContractPrice, getTokenData } from "domain/synthetics/tokens";
import { DecreasePositionSwapType, OrderType } from "./types";
import { isDevelopment } from "config/env";
import { PriceOverrides, simulateExecuteOrderTxn } from "./simulateExecuteOrderTxn";
import { isMarketOrder } from "./utils";
import { getPositionKey } from "domain/synthetics/positions";
import { PositionUpdate } from "context/SyntheticsEvents";
import { formatUsd } from "lib/numbers";

const { AddressZero } = ethers.constants;

export type DecreaseOrderParams = {
  account: string;
  executionFee: BigNumber;
  referralCode?: string;
  tokensData: TokensData;
  marketAddress: string;
  swapPath: string[];
  initialCollateralAddress: string;
  initialCollateralDeltaAmount: BigNumber;
  indexTokenAddress: string;
  receiveTokenAddress: string;
  triggerPrice?: BigNumber;
  sizeDeltaUsd?: BigNumber;
  isLong: boolean;
  acceptablePrice: BigNumber;
  decreasePositionSwapType: DecreasePositionSwapType;
  orderType: OrderType.MarketDecrease | OrderType.LimitDecrease | OrderType.StopLossDecrease;
  setPendingPositionUpdate: (update: PositionUpdate) => void;
};

export async function createDecreaseOrderTxn(chainId: number, library: Web3Provider, p: DecreaseOrderParams) {
  const exchangeRouter = new ethers.Contract(
    getContract(chainId, "ExchangeRouter"),
    ExchangeRouter.abi,
    library.getSigner()
  );

  const orderVaultAddress = getContract(chainId, "OrderVault");

  const isNativeReceive = p.receiveTokenAddress === NATIVE_TOKEN_ADDRESS;

  const indexToken = getTokenData(p.tokensData, p.indexTokenAddress);

  if (!indexToken?.prices) throw new Error("Index token prices are not available");

  const wntAmount = p.executionFee;

  const minOutputAmount = BigNumber.from(0);

  const multicall = [
    { method: "sendWnt", params: [orderVaultAddress, wntAmount] },

    {
      method: "createOrder",
      params: [
        {
          addresses: {
            receiver: p.account,
            initialCollateralToken: convertTokenAddress(chainId, p.initialCollateralAddress, "wrapped"),
            callbackContract: AddressZero,
            market: p.marketAddress,
            swapPath: p.swapPath,
          },
          numbers: {
            sizeDeltaUsd: p.sizeDeltaUsd,
            initialCollateralDeltaAmount: p.initialCollateralDeltaAmount,
            triggerPrice: convertToContractPrice(p.triggerPrice || BigNumber.from(0), indexToken.decimals),
            acceptablePrice: convertToContractPrice(p.acceptablePrice, indexToken.decimals),
            executionFee: p.executionFee,
            callbackGasLimit: BigNumber.from(0),
            minOutputAmount: minOutputAmount,
          },
          orderType: p.orderType,
          decreasePositionSwapType: p.decreasePositionSwapType,
          isLong: p.isLong,
          shouldUnwrapNativeToken: isNativeReceive,
        },
        encodeReferralCode(p.referralCode || ""),
      ],
    },
  ];

  if (isDevelopment()) {
    // eslint-disable-next-line no-console
    console.debug("positionDecreaseTxn multicall", multicall);
  }

  const encodedPayload = multicall
    .filter(Boolean)
    .map((call) => exchangeRouter.interface.encodeFunctionData(call!.method, call!.params));

  const primaryPriceOverrides: PriceOverrides = {};
  const secondaryPriceOverrides: PriceOverrides = {};

  if (p.triggerPrice) {
    secondaryPriceOverrides[p.indexTokenAddress] = {
      minPrice: p.triggerPrice,
      maxPrice: p.triggerPrice,
    };
  } else {
    // primaryPriceOverrides[p.indexTokenAddress] = {
    //   minPrice: acceptablePrice,
    //   maxPrice: acceptablePrice,
    // };
  }

  await simulateExecuteOrderTxn(chainId, library, {
    primaryPriceOverrides,
    secondaryPriceOverrides,
    createOrderMulticallPayload: encodedPayload,
    value: wntAmount,
    tokensData: p.tokensData,
  });

  const longText = p.isLong ? t`Long` : t`Short`;

  const orderLabel = t`Decrease ${longText} ${indexToken.symbol} by ${formatUsd(p.sizeDeltaUsd)}`;

  const txn = await callContract(chainId, exchangeRouter, "multicall", [encodedPayload], {
    value: wntAmount,
    sentMsg: t`${orderLabel} order sent`,
    successMsg: t`${orderLabel} order created`,
    failMsg: t`${orderLabel} order failed`,
  }).then(() => {
    if (isMarketOrder(p.orderType)) {
      p.setPendingPositionUpdate({
        positionKey: getPositionKey(p.account, p.marketAddress, p.initialCollateralAddress, p.isLong)!,
        isIncrease: false,
      });
    }
  });

  return txn;
}