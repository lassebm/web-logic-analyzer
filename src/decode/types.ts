// A small, native-TS protocol-decoder API modeled on sigrok's Python PD model
// (self.wait() / self.put()). Decoders are generator functions that yield wait
// conditions and receive the pin state at the matched sample.

/** Edge/level match code for one channel within a wait condition. */
export type MatchCode =
  | "l" // level low
  | "h" // level high
  | "r" // rising edge
  | "f" // falling edge
  | "e" // either edge
  | "s"; // stable (no edge)

/** One wait condition: per-channel match codes, or a fixed sample skip. */
export type WaitCondition = { skip: number } | { [channel: number]: MatchCode };

/** A wait yields either a single condition or a list (OR-matched). */
export type WaitInput = WaitCondition | WaitCondition[];

/** Pin values (0/1) indexed by the decoder's logical channel number. */
export type PinState = ReadonlyArray<0 | 1>;

export interface ChannelDef {
  id: string;
  name: string;
  desc: string;
  required: boolean;
}

export interface OptionDef {
  id: string;
  desc: string;
  default: string | number;
  /** Allowed values for enum-style options (rendered as a fixed dropdown). */
  values?: Array<string | number>;
  /** Suggested values for a free-text option (rendered as an editable dropdown:
   *  pick a preset or type a custom value, e.g. baud rate). */
  presets?: Array<string | number>;
}

/** [class-id, human-readable name] — index in the array is the annotation class. */
export type AnnotationDef = [string, string];

export interface AnnotationRowDef {
  id: string;
  name: string;
  /** Annotation class indices that render on this row. */
  classes: number[];
}

export interface DecoderMeta {
  id: string;
  name: string;
  longname: string;
  desc: string;
  channels: ChannelDef[];
  options: OptionDef[];
  annotations: AnnotationDef[];
  annotationRows: AnnotationRowDef[];
  /** Packet type this decoder emits for stacking (e.g. 'byte'). */
  outputType?: string;
  /** For stacked decoders: the packet type they consume (e.g. 'byte'). */
  inputType?: string;
}

/** A typed item emitted by a decoder for a stacked decoder to consume. */
export interface Packet {
  startSample: number;
  endSample: number;
  type: string;
  data: unknown;
}

/** `data` payload of a 'byte' packet (emitted by uart/spi/i2c/onewire/can). */
export interface BytePacket {
  value: number;
}

/** Context handed to a decoder's generator; the engine mutates it as it advances. */
export interface DecoderContext {
  readonly samplerate: number;
  /** Current sample index (updated after each wait). */
  readonly samplenum: number;
  /** For OR-lists: which yielded conditions matched at the current sample. */
  readonly matched: ReadonlyArray<boolean>;
  /** Resolved option values keyed by option id. */
  readonly options: Readonly<Record<string, string | number>>;
  /** Pin value of a logical channel at the current sample. */
  pin(channel: number): 0 | 1;
  /** Emit an annotation spanning [startSample, endSample]. */
  put(
    startSample: number,
    endSample: number,
    annClass: number,
    texts: string[],
  ): void;
  /** Emit a typed packet for stacked decoders to consume. */
  emit(
    startSample: number,
    endSample: number,
    type: string,
    data: unknown,
  ): void;
}

/** Context handed to a stacked decoder, which consumes packets rather than samples. */
export interface StackedContext {
  readonly options: Readonly<Record<string, string | number>>;
  put(
    startSample: number,
    endSample: number,
    annClass: number,
    texts: string[],
  ): void;
}

export interface Decoder {
  meta: DecoderMeta;
  /** Logic decoder: generator yielding wait conditions, receiving pin state. */
  decode?(ctx: DecoderContext): Generator<WaitInput, void, PinState>;
  /** Stacked decoder: consumes packets from a source decoder. */
  decodeStacked?(packets: Packet[], ctx: StackedContext): void;
}

export interface Annotation {
  startSample: number;
  endSample: number;
  annClass: number;
  /** Alternate texts, longest first (for zoom-dependent rendering). */
  texts: string[];
}
