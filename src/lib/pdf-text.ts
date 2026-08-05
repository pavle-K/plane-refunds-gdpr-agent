import { PDFParse } from "pdf-parse";

/** Extracts plain text from a PDF buffer — used for airline/OTA e-ticket and
 * receipt attachments, which often carry booking details the email body omits. */
export async function extractPdfText(buffer: Buffer): Promise<string> {
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  return result.text;
}
