// Types for the WING binary metering protocol (TCP:2222 control channel + UDP level-meter stream).
// Completely separate from the OSC control-plane protocol (UDP:2223).

export type MeterGroupType =
  | "channel"
  | "aux"
  | "bus"
  | "main"
  | "matrix"
  | "dca"
  | "fx"
  | "source"
  | "output"
  | "monitor"
  | "rta"
  | "channelV2"
  | "auxV2"
  | "busV2"
  | "mainV2"
  | "matrixV2";

export interface MeterRequest {
  type: MeterGroupType;
  /** 1-based indices (1..128). Omit for the index-less groups: "monitor" and "rta". */
  indices?: number[];
}

export type MeterFrame =
  | {
      type: "channel" | "aux" | "bus" | "main" | "matrix";
      index: number;
      inputL_dB: number;
      inputR_dB: number;
      outputL_dB: number;
      outputR_dB: number;
      gateKey_dB: number;
      gateGain_dB: number;
      dynKey_dB: number;
      dynGain_dB: number;
    }
  | {
      type: "channelV2" | "auxV2" | "busV2" | "mainV2" | "matrixV2";
      index: number;
      inputL_dB: number;
      inputR_dB: number;
      outputL_dB: number;
      outputR_dB: number;
      gateKey_dB: number;
      gateGain_dB: number;
      gateLed: boolean;
      dynKey_dB: number;
      dynGain_dB: number;
      dynActive: boolean;
      automixGain_dB: number;
    }
  | {
      type: "dca";
      index: number;
      preFaderL_dB: number;
      preFaderR_dB: number;
      postFaderL_dB: number;
      postFaderR_dB: number;
    }
  | {
      type: "fx";
      index: number;
      inputL_dB: number;
      inputR_dB: number;
      outputL_dB: number;
      outputR_dB: number;
      state: number[];
    }
  | {
      type: "source" | "output";
      index: number;
      level_dB: number;
    }
  | {
      type: "monitor";
      soloL_dB: number;
      soloR_dB: number;
      mon1L_dB: number;
      mon1R_dB: number;
      mon2L_dB: number;
      mon2R_dB: number;
    }
  | {
      type: "rta";
      bands_dB: number[];
    };

export interface MeterSnapshot {
  reportId: number;
  receivedAt: number;
  frames: MeterFrame[];
}
