import { fetchFigmaComments, fetchFigmaFile } from "./figma-client";
import { buildDiscoveryText, parseFigJamDocument } from "./parse-figjam";
import { formatDesignAsText, parseFigmaDesign } from "./parse-figma-design";
import { getSupabaseAdmin } from "./supabase";

export type SourceKind = "discovery" | "prototype";

export interface SourceMetadata {
  name: string;
  lastModified: string;
  editorType: string;
  version: string;
  summary: Record<string, number>;
}

export interface ExtractedSource {
  kind: SourceKind;
  fileKey: string;
  metadata: SourceMetadata;
  text: string;
}

export interface RefreshedSources {
  discovery: ExtractedSource;
  prototype: ExtractedSource | null;
}

function getFigmaToken(): string {
  const token = process.env.FIGMA_TOKEN;
  if (!token || token === "seu_token_figma_aqui") {
    throw new Error(
      "FIGMA_TOKEN não configurado no servidor. Defina a variável de ambiente."
    );
  }
  return token;
}

export async function extractDiscovery(fileKey: string): Promise<ExtractedSource> {
  const token = getFigmaToken();

  const [file, commentsResponse] = await Promise.all([
    fetchFigmaFile(fileKey, token),
    fetchFigmaComments(fileKey, token).catch(() => ({ comments: [] })),
  ]);

  const parsed = parseFigJamDocument(file.document, commentsResponse.comments);
  const text = buildDiscoveryText(parsed, file.name);

  return {
    kind: "discovery",
    fileKey,
    metadata: {
      name: file.name,
      lastModified: file.lastModified,
      editorType: file.editorType,
      version: file.version,
      summary: parsed.summary as unknown as Record<string, number>,
    },
    text,
  };
}

export async function extractPrototype(fileKey: string): Promise<ExtractedSource> {
  const token = getFigmaToken();

  const file = await fetchFigmaFile(fileKey, token);
  const parsed = parseFigmaDesign(file.document);
  const text = formatDesignAsText(file.document, parsed);

  return {
    kind: "prototype",
    fileKey,
    metadata: {
      name: file.name,
      lastModified: file.lastModified,
      editorType: file.editorType,
      version: file.version,
      summary: parsed.summary as unknown as Record<string, number>,
    },
    text,
  };
}

/**
 * Re-extrai o Discovery (e o Protótipo, se houver) direto do Figma e atualiza
 * `project_sources`. Usado a cada "Analisar de novo" para que a IA enxergue a
 * versão atual do board, não a extração inicial.
 */
export async function refreshProjectSources(project: {
  id: string;
  discovery_file_key: string | null;
  prototype_file_key: string | null;
}): Promise<RefreshedSources> {
  if (!project.discovery_file_key) {
    throw new Error("Projeto sem file key do Discovery para re-extrair.");
  }

  const discovery = await extractDiscovery(project.discovery_file_key);
  const prototype = project.prototype_file_key
    ? await extractPrototype(project.prototype_file_key)
    : null;

  const admin = getSupabaseAdmin();
  const rows: Array<{
    project_id: string;
    kind: SourceKind;
    figma_file_key: string;
    metadata: unknown;
    discovery_text: string;
  }> = [
    {
      project_id: project.id,
      kind: "discovery",
      figma_file_key: discovery.fileKey,
      metadata: discovery.metadata,
      discovery_text: discovery.text,
    },
  ];
  if (prototype) {
    rows.push({
      project_id: project.id,
      kind: "prototype",
      figma_file_key: prototype.fileKey,
      metadata: prototype.metadata,
      discovery_text: prototype.text,
    });
  }

  await admin
    .from("project_sources")
    .upsert(rows, { onConflict: "project_id,kind" });

  return { discovery, prototype };
}
