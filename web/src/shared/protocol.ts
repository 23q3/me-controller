export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type RecipeEntry = {
  item: string;
  label?: string;
  count?: number;
  targetCount?: number;
};

// 样板（recipes.db）：配方的唯一权威——输入/输出/工序地址；
// 目标经 recipeId 引用样板，条目不携带 targetCount（那是目标侧库存策略）
export type RecipeSnapshot = {
  id: string;
  name?: string;
  address?: string;
  products?: RecipeEntry[];
  inputs?: RecipeEntry[];
};

export type TargetSnapshot = {
  id: string;
  enabled?: boolean;
  address?: string;
  priority?: number;
  recipeId?: string;
  products?: RecipeEntry[];
  inputs?: RecipeEntry[];
  status?: string;
  message?: string;
  productCount?: number;
  productCounts?: Record<string, JsonValue>;
  inputCounts?: Record<string, JsonValue>;
  targetCount?: number;
  dependencyDemand?: number;
  neededInputs?: number;
  neededInputItems?: Record<string, number>;
  promisedInputs?: number;
  promisedInputItems?: Record<string, number>;
  nextExpiry?: number;
};

export type ControllerSnapshot = {
  schema?: string;
  time?: number;
  network?: {
    ready?: boolean;
    error?: string | null;
    stockEntries?: number;
    stockSerial?: number;
    lastStockReadAt?: number;
    stockName?: string;
    monitorName?: string;
  };
  dependency?: {
    passes?: number;
    demandByTarget?: Record<string, JsonValue>;
  };
  summary?: {
    total?: number;
    enabled?: number;
    requested?: number;
    waiting?: number;
    error?: number;
    satisfied?: number;
    disabled?: number;
  };
  targets?: TargetSnapshot[];
  recipes?: RecipeSnapshot[];
  commands?: CommandRecord[];
  stockCounts?: Record<string, number>;
};

export type CommandRecord = {
  id?: string;
  commandId?: string;
  kind?: string;
  source?: string;
  targetId?: string;
  status?: string;
  item?: string;
  items?: Array<{ item?: string; count?: number }>;
  wanted?: number;
  requested?: number;
  createdAt?: number;
  completedAt?: number;
  error?: string;
};

export type ControllerCommand = {
  commandId?: string;
  id?: string;
  kind: string;
  type?: string;
  source?: string;
  targetId?: string;
  target?: JsonValue;
  recipeId?: string;
  recipe?: JsonValue;
  batches?: number;
  enabled?: boolean;
  address?: string;
  item?: string;
  count?: number;
  amount?: number;
  // 多物品请求：全部条目并入一张订单（同一 PackageOrder，理包机可按订单合包）
  items?: Array<{ item: string; count: number }>;
  trackCommitment?: boolean;
  options?: Record<string, JsonValue>;
};

export type BridgeEnvelope =
  | {
      type: "hello";
      clientId?: string;
      protocol?: string;
      time?: number;
    }
  | {
      type: "snapshot" | "heartbeat";
      clientId?: string;
      time?: number;
      snapshot?: ControllerSnapshot;
    }
  | {
      type: "command_result";
      clientId?: string;
      time?: number;
      commandId?: string;
      ok?: boolean;
      response?: JsonValue;
    }
  | {
      type: "error";
      clientId?: string;
      time?: number;
      error?: string;
    };

// 服务端 sqlite 命令账本的行形状；/api/status 与 /ui state 信封实际下发的就是它
export type StoredCommand = {
  commandId: string;
  kind: string;
  status: string;
  request: JsonValue;
  response?: JsonValue;
  createdAt: number;
  sentAt?: number;
  completedAt?: number;
};

export type UiEnvelope =
  | {
      type: "state";
      bridge: BridgeState;
      snapshot: ControllerSnapshot | null;
      commands: StoredCommand[];
    }
  | {
      type: "command_result";
      commandId?: string;
      ok: boolean;
      response: JsonValue;
    }
  | {
      type: "command_accepted";
      commandId?: string;
      ok: boolean;
      response: JsonValue;
    }
  | {
      type: "error";
      error: string;
    };

export type BridgeState = {
  connected: boolean;
  clientId?: string;
  protocol?: string;
  connectedAt?: number;
  lastSeenAt?: number;
};
