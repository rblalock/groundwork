declare module "heic-decode" {
  /** Decodes the first top-level image of a HEIC/HEIF file to RGBA pixels. */
  export default function decode(input: { buffer: Uint8Array | ArrayBuffer }): Promise<{
    width: number;
    height: number;
    data: Uint8ClampedArray;
  }>;
  /**
   * The top-level images, sized by libheif without decoding any; `decode` decodes one. Call `dispose`
   * when done with them.
   */
  export function all(input: { buffer: Uint8Array | ArrayBuffer }): Promise<
    Array<{ width: number; height: number; decode(): Promise<{ width: number; height: number; data: Uint8ClampedArray }> }> & {
      dispose(): void;
    }
  >;
}
