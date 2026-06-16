import { CheckCircleOutlined, CommentOutlined, UndoOutlined } from "@ant-design/icons";
import { Button, Card, Flex, Input, Modal, Space, Tag, Tooltip, Typography } from "antd";
import { useState } from "react";
import {
  CATEGORIA_LABELS,
  SEVERIDADE_LABELS,
  SOURCE_LABELS,
} from "../lib/labels";
import type { Gap, GapSeveridade, GapSource, GapStatus } from "../types";

const { Text, Paragraph } = Typography;
const { TextArea } = Input;

function sevTagColor(sev: GapSeveridade): "error" | "warning" | "default" {
  if (sev === "alta") return "error";
  if (sev === "media") return "warning";
  return "default";
}

function sourceTagColor(source: GapSource): string {
  if (source === "discovery") return "blue";
  if (source === "prototype") return "purple";
  return "cyan";
}

function SourceBadge({ source }: { source: GapSource }) {
  return <Tag color={sourceTagColor(source)}>{SOURCE_LABELS[source]}</Tag>;
}

interface GapCardProps {
  gap: Gap;
  resposta?: string;
  status?: GapStatus;
  onMarkResolved?: (comment: string, reanalyze?: boolean) => Promise<void>;
  onReopen?: () => Promise<void>;
  onSendFigmaReminder?: () => Promise<void>;
  showActions?: boolean;
  figmaReminderAvailable?: boolean;
}

export function GapCard({
  gap,
  resposta,
  status,
  onMarkResolved,
  onReopen,
  onSendFigmaReminder,
  showActions = true,
  figmaReminderAvailable = false,
}: GapCardProps) {
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolveComment, setResolveComment] = useState("");
  const [savingResolve, setSavingResolve] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [sendingReminder, setSendingReminder] = useState(false);

  const effectiveStatus = status ?? gap.status;
  const isResolved = effectiveStatus === "resolvido";
  const reminderSent = Boolean(gap.figma_reminder_sent_at);

  function formatReminderDate(iso: string): string {
    return new Date(iso).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  async function handleMarkResolved(reanalyze: boolean) {
    if (!onMarkResolved || !resolveComment.trim()) return;
    setSavingResolve(true);
    try {
      await onMarkResolved(resolveComment.trim(), reanalyze);
      setResolveOpen(false);
      setResolveComment("");
    } finally {
      setSavingResolve(false);
    }
  }

  async function handleReopen() {
    if (!onReopen) return;
    setReopening(true);
    try {
      await onReopen();
    } finally {
      setReopening(false);
    }
  }

  async function handleSendReminder() {
    if (!onSendFigmaReminder || reminderSent) return;
    setSendingReminder(true);
    try {
      await onSendFigmaReminder();
    } finally {
      setSendingReminder(false);
    }
  }

  return (
    <>
      <Card
        size="small"
        style={{
          marginBottom: 12,
          opacity: isResolved ? 0.72 : 1,
          borderColor: isResolved ? "#b7eb8f" : undefined,
        }}
      >
        <Space wrap size={[8, 4]} style={{ marginBottom: 8 }}>
          <Tag color={sevTagColor(gap.severidade)}>{SEVERIDADE_LABELS[gap.severidade]}</Tag>
          <Tag>{CATEGORIA_LABELS[gap.categoria] ?? gap.categoria}</Tag>
          <SourceBadge source={gap.source} />
          {showActions && isResolved && <Tag color="success">Resolvido</Tag>}
          {showActions && reminderSent && (
            <Tooltip
              title={
                gap.figma_reminder_node_name
                  ? `Publicado em "${gap.figma_reminder_node_name}"`
                  : undefined
              }
            >
              <Tag icon={<CheckCircleOutlined />} color="processing">
                Lembrete enviado
                {gap.figma_reminder_sent_at
                  ? ` · ${formatReminderDate(gap.figma_reminder_sent_at)}`
                  : ""}
              </Tag>
            </Tooltip>
          )}
          <Text type="secondary" style={{ fontSize: 12 }}>
            {gap.localizacao}
          </Text>
        </Space>

        <Text strong style={{ display: "block", marginBottom: 8 }}>
          {gap.titulo}
        </Text>
        <Paragraph style={{ marginBottom: gap.sugestao ? 8 : 0 }}>{gap.descricao}</Paragraph>

        {gap.sugestao && (
          <Paragraph type="secondary" style={{ marginBottom: 8 }}>
            <Text strong>Sugestão:</Text> {gap.sugestao}
          </Paragraph>
        )}

        {showActions && (onMarkResolved || onReopen || onSendFigmaReminder) && (
          <>
            {isResolved && (resposta ?? gap.resposta)?.trim() && (
              <Paragraph
                type="secondary"
                style={{ marginBottom: 12, whiteSpace: "pre-wrap" }}
              >
                <Text strong>Comentário:</Text> {resposta ?? gap.resposta}
              </Paragraph>
            )}

            <Flex wrap="wrap" gap={8}>
              {!isResolved && onMarkResolved && (
                <Button
                  type="primary"
                  onClick={() => {
                    setResolveComment(resposta ?? gap.resposta ?? "");
                    setResolveOpen(true);
                  }}
                >
                  Marcar como resolvido
                </Button>
              )}
              {isResolved && onReopen && (
                <Button icon={<UndoOutlined />} onClick={handleReopen} loading={reopening}>
                  Reabrir gap
                </Button>
              )}
              {figmaReminderAvailable && onSendFigmaReminder && (
                <Tooltip
                  title={
                    reminderSent
                      ? "Um lembrete já foi enviado para este gap no Figma"
                      : undefined
                  }
                >
                  <Button
                    icon={reminderSent ? <CheckCircleOutlined /> : <CommentOutlined />}
                    onClick={handleSendReminder}
                    loading={sendingReminder}
                    disabled={reminderSent}
                  >
                    {reminderSent ? "Lembrete enviado" : "Lembrete no Figma"}
                  </Button>
                </Tooltip>
              )}
            </Flex>
          </>
        )}

        {!showActions && (
          <div
            style={{
              marginTop: 12,
              padding: 12,
              background: "#fafafa",
              borderRadius: 8,
              border: "1px solid #e6e6e8",
            }}
          >
            <Space direction="vertical" size={10} style={{ width: "100%" }}>
              <div>
                <Text type="secondary" style={{ fontSize: 11, letterSpacing: "0.06em" }}>
                  STATUS
                </Text>
                <div style={{ marginTop: 4 }}>
                  <Tag color={isResolved ? "success" : "default"}>
                    {isResolved ? "Resolvido" : "Aberto"}
                  </Tag>
                </div>
              </div>

              {(resposta ?? gap.resposta)?.trim() ? (
                <div>
                  <Text type="secondary" style={{ fontSize: 11, letterSpacing: "0.06em" }}>
                    COMENTÁRIO
                  </Text>
                  <Paragraph style={{ margin: "4px 0 0", whiteSpace: "pre-wrap" }}>
                    {resposta ?? gap.resposta}
                  </Paragraph>
                </div>
              ) : (
                <div>
                  <Text type="secondary" style={{ fontSize: 11, letterSpacing: "0.06em" }}>
                    COMENTÁRIO
                  </Text>
                  <Paragraph type="secondary" style={{ margin: "4px 0 0", fontSize: 13 }}>
                    Nenhum comentário registrado.
                  </Paragraph>
                </div>
              )}

              {reminderSent && (
                <div>
                  <Text type="secondary" style={{ fontSize: 11, letterSpacing: "0.06em" }}>
                    LEMBRETE NO FIGMA
                  </Text>
                  <Paragraph style={{ margin: "4px 0 0", fontSize: 13 }}>
                    Enviado
                    {gap.figma_reminder_sent_at &&
                      ` · ${formatReminderDate(gap.figma_reminder_sent_at)}`}
                    {gap.figma_reminder_node_name && ` · ${gap.figma_reminder_node_name}`}
                  </Paragraph>
                </div>
              )}
            </Space>
          </div>
        )}
      </Card>

      <Modal
        title="Marcar gap como resolvido"
        open={resolveOpen}
        onCancel={() => setResolveOpen(false)}
        footer={[
          <Button key="cancel" onClick={() => setResolveOpen(false)} disabled={savingResolve}>
            Cancelar
          </Button>,
          <Button
            key="resolve"
            onClick={() => handleMarkResolved(false)}
            loading={savingResolve}
            disabled={!resolveComment.trim()}
          >
            Marcar como resolvido
          </Button>,
          <Button
            key="reanalyze"
            type="primary"
            onClick={() => handleMarkResolved(true)}
            loading={savingResolve}
            disabled={!resolveComment.trim()}
          >
            Marcar e analisar com feedback
          </Button>,
        ]}
      >
        <Paragraph type="secondary" style={{ marginBottom: 12 }}>
          Descreva o que foi feito para endereçar este gap. O comentário fica registrado
          na análise e ajuda o time na próxima rodada.
        </Paragraph>
        <Paragraph type="secondary" style={{ marginBottom: 12, fontSize: 12 }}>
          <strong>Marcar e analisar com feedback</strong> baixa a versão atual do board,
          cria uma nova análise no histórico e pede à IA para reconsiderar os gaps com
          base no seu comentário.
        </Paragraph>
        <TextArea
          rows={4}
          value={resolveComment}
          onChange={(e) => setResolveComment(e.target.value)}
          placeholder="Ex.: Atualizamos o fluxo no FigJam e incluímos o critério de aceite..."
        />
      </Modal>
    </>
  );
}
