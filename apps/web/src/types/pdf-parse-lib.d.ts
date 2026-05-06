// pdf-parse's index.js runs a sample-PDF read at import time; we
// import the inner lib path directly to avoid that side effect, but
// the published @types/pdf-parse only declares the package root.
// This shim covers the deep import.
declare module 'pdf-parse/lib/pdf-parse.js' {
  function pdfParse(buffer: Buffer): Promise<{ text: string }>;
  export default pdfParse;
}
