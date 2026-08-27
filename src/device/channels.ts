// Channel identity, shared by every layer above the transport. This lives in
// device/ rather than usb/ because the model, view, decoders and import/export
// all need it and none of them should know which bus the samples came from.

/** Widest channel count any backend can present. One byte per sample. */
export const NUM_CHANNELS = 8;

/** Display names for the logic channels, indexed by channel number. */
export const CHANNEL_NAMES = ["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7"];
