import JSZip from "jszip";

export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[^a-z0-9-_]+/gi, "_").replace(/^_|_$/g, "");
  return cleaned || "projeto";
}

export function downloadText(text: string, filename: string): void {
  const blob = new Blob([text], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export async function downloadDocsAsZip(
  files: { filename: string; content: string }[],
  zipBaseName: string
): Promise<void> {
  if (files.length === 0) return;

  const zip = new JSZip();
  for (const file of files) {
    zip.file(file.filename, file.content);
  }

  const blob = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${sanitizeFilename(zipBaseName)}.zip`;
  a.click();
  URL.revokeObjectURL(url);
}
