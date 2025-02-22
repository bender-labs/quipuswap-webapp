import Vue from "vue";
import Vuex from "vuex";
import { BeaconWallet } from "@taquito/beacon-wallet";
import { TempleWallet } from "@temple-wallet/dapp";
import {
  QSAsset,
  getTokens,
  getNetwork,
  getCustomTokens,
  LOGO_URL,
  ReadOnlySigner,
  michelEncoder,
  getTokenMetadata,
  getStorage,
  QSTokenType,
  sanitizeImgUri,
  getContract,
  filteredWhitelist,
  sharesFromNat,
  getDexShares,
} from "@/core";
import { TezosToolkit } from "@taquito/taquito";
import { Route } from "vue-router";
import router from "../router";
import { MAINNET_V1_0_DEX_WHITELIST } from "../v1_0whitelist";
import BigNumber from "bignumber.js";

Vue.use(Vuex);

interface StoreState {
  tokensLoading: boolean;
  tokens: QSAsset[];
  account: { pkh: string };
  v0Pools: any[];
}

const store = new Vuex.Store<StoreState>({
  state: {
    tokensLoading: false,
    tokens: [],
    account: getAccountInitial(),
    v0Pools: [],
  },
  mutations: {
    tokensLoading(state, tokensLoading) {
      state.tokensLoading = tokensLoading;
    },
    tokens(state, tokens) {
      state.tokens = tokens;
    },
    addToken(state, token) {
      state.tokens = [token, ...state.tokens];
    },
    account(state, account) {
      state.account = account;
    },
    setV0Pools(state, pools) {
      state.v0Pools = pools;
    },
    pushV0Pools(state, pool) {
      state.v0Pools.push(pool);
    },
  },
});

export default store;

async function loadV0Pools() {
  try {
    const me = store.state.account.pkh;
    if (getNetwork().type === "main" && me) {
      store.commit("setV0Pools", []);
      await Promise.all(
        MAINNET_V1_0_DEX_WHITELIST.map(async pool => {
          const shares = await getDexShares(me, pool.dexAddress);
          const total = shares ? sharesFromNat(shares.total) : new BigNumber(0);
          if (total.isGreaterThan(0)) {
            store.commit("pushV0Pools", {
              ...pool,
              balance: total.toFixed(),
              link: `${process.env.VUE_APP_OLD_QUIPUSWAP_URL ||
                ""}/invest/remove-liquidity/${pool.dexAddress}`,
            });
          }
        })
      );
    } else {
      store.commit("setV0Pools", []);
    }
  } catch (_err) {}
}
loadV0Pools();

store.subscribe(mutation => {
  if (mutation.type === "account") {
    loadV0Pools();
  }
});

loadTokens();
router.onReady((route: Route) => {
  [route.query.from, route.query.to].forEach(assetSlug => {
    if (assetSlug && assetSlug !== "tez") {
      try {
        const [tokenAddress, fa2TokenId] = (assetSlug as any).split("_");
        loadCustomTokenIfExist(tokenAddress, fa2TokenId);
      } catch {}
    }
  });

  if (route.params.token) {
    (async () => {
      try {
        const dex = await getContract(route.params.token);
        const { storage } = await dex.storage<any>();
        loadCustomTokenIfExist(
          storage.token_address,
          storage.token_id ? +storage.token_id : undefined
        );
      } catch {}
    })();
  }
});

export async function loadTokens() {
  try {
    store.commit("tokensLoading", true);
    store.commit("tokens", await getTokens());
  } catch (err) {
    console.error(err);
  } finally {
    store.commit("tokensLoading", false);
  }
}

export async function loadCustomTokenIfExist(
  contractAddress: string,
  fa2TokenId?: number
) {
  try {
    const currentCustom = getCustomTokens();
    if (
      filteredWhitelist.some(wt =>
        fa2TokenId !== undefined
          ? wt.contractAddress === contractAddress &&
            wt.fa2TokenId === fa2TokenId
          : wt.contractAddress === contractAddress
      ) ||
      currentCustom.some((ct: QSAsset) =>
        ct.tokenType === QSTokenType.FA2
          ? ct.id === contractAddress && ct.fa2TokenId === fa2TokenId
          : ct.id === contractAddress
      )
    ) {
      return;
    }

    const { fa1_2FactoryContract, fa2FactoryContract } = getNetwork();
    if (!fa1_2FactoryContract && !fa2FactoryContract) {
      throw new Error("Contracts for this network not found");
    }

    let exchange;
    if (fa2TokenId !== undefined) {
      if (fa2FactoryContract) {
        const facStorage = await getStorage(fa2FactoryContract);
        exchange = await facStorage.token_to_exchange.get([
          contractAddress,
          fa2TokenId.toString(),
        ]);
      }
    } else {
      if (fa1_2FactoryContract) {
        const facStorage = await getStorage(fa1_2FactoryContract);
        exchange = await facStorage.token_to_exchange.get(contractAddress);
      }
    }

    if (exchange) {
      const metadata = await getTokenMetadata(contractAddress, fa2TokenId);
      addCustomToken({
        type: "token" as const,
        tokenType:
          fa2TokenId !== undefined ? QSTokenType.FA2 : QSTokenType.FA1_2,
        id: contractAddress,
        fa2TokenId,
        exchange,
        decimals: metadata.decimals,
        symbol: metadata.symbol,
        name: metadata.name,
        imgUrl: sanitizeImgUri(metadata.thumbnailUri),
      });
    }
  } catch {}
}

export function addCustomToken(token: QSAsset) {
  try {
    const current = getCustomTokens();
    const net = getNetwork();
    localStorage.setItem(
      `custom_tokens_v1.2_${net.id}`,
      JSON.stringify([token, ...current])
    );
  } catch {}
  store.commit("addToken", token);
}

const beaconWallet = new BeaconWallet({
  name: "Quipuswap",
  iconUrl: LOGO_URL,
});

export async function useWallet(
  connectType?: "temple" | "beacon",
  forcePermission = false
) {
  if (!forcePermission && !getAccount().pkh) {
    throw new Error("Not connected");
  }

  if (!connectType) {
    const last = getLastUsedConnect();
    if (!last) {
      signout();
      throw new Error("Not connected");
    }

    connectType = last;
  }

  return connectType === "temple"
    ? useWalletTemple(forcePermission)
    : useWalletBeacon(forcePermission);
}

async function useWalletTemple(forcePermission: boolean) {
  const net = getNetwork();

  const available = await TempleWallet.isAvailable();
  if (!available) {
    throw new Error("Temple Wallet not installed");
  }

  let perm;
  if (!forcePermission) {
    perm = await TempleWallet.getCurrentPermission();
  }

  const wallet = new TempleWallet("Quipuswap", perm);

  if (!wallet.connected) {
    await wallet.connect(net.id as any, { forcePermission: true });
  }

  const tezos = wallet.toTezos();
  tezos.setPackerProvider(michelEncoder);
  const { pkh, publicKey } = wallet.permission!;
  tezos.setSignerProvider(new ReadOnlySigner(pkh, publicKey));
  setLastUsedConnect("temple");
  if (getAccount().pkh !== pkh) {
    setAccount(pkh);
  }
  return tezos;
}

async function useWalletBeacon(forcePermission: boolean) {
  const net = getNetwork();

  const activeAccount = await beaconWallet.client.getActiveAccount();
  if (forcePermission || !activeAccount) {
    if (activeAccount) {
      await beaconWallet.clearActiveAccount();
    }
    await beaconWallet.requestPermissions({
      network: { type: toBeaconNetworkType(net.id) },
    });
  }

  const tezos = new TezosToolkit(net.rpcBaseURL);
  tezos.setPackerProvider(michelEncoder);
  tezos.setWalletProvider(beaconWallet);
  const activeAcc = await beaconWallet.client.getActiveAccount();
  if (!activeAcc) {
    throw new Error("Not connected");
  }

  tezos.setSignerProvider(
    new ReadOnlySigner(activeAcc.address, activeAcc.publicKey)
  );
  setLastUsedConnect("beacon");
  if (getAccount().pkh !== activeAcc.address) {
    setAccount(activeAcc.address);
  }
  return tezos;
}

export function getAccount() {
  return store.state.account;
}

export function setAccount(pkh: string) {
  localStorage.setItem("accpkh", pkh);
  store.commit("account", { pkh });
}

export function signout() {
  cleanLastUsedConnect();
  localStorage.removeItem("accpkh");
  store.commit("account", { pkh: "" });
}

function getAccountInitial() {
  const pkh = localStorage.getItem("accpkh");
  return { pkh: pkh || "" };
}

function toBeaconNetworkType(netId: string): any {
  return netId === "edo2net" ? "edonet" : netId;
}

function getLastUsedConnect() {
  return localStorage.getItem("last-used-connect") as
    | "temple"
    | "beacon"
    | null;
}

function setLastUsedConnect(val: "temple" | "beacon") {
  return localStorage.setItem("last-used-connect", val);
}

function cleanLastUsedConnect() {
  localStorage.removeItem("last-used-connect");
}
