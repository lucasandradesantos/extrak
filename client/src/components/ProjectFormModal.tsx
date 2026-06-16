import { Alert, Button, Flex, Form, Input, Modal, Typography } from "antd";
import { useEffect } from "react";
import type { ProjectSummary } from "../types";

const { Paragraph } = Typography;

export interface ProjectFormValues {
  name?: string;
  discoveryUrl: string;
  prototypeUrl?: string;
}

interface ProjectFormModalProps {
  open: boolean;
  mode: "create" | "edit";
  project?: ProjectSummary | null;
  loading?: boolean;
  error?: string | null;
  onCancel: () => void;
  onSubmit: (values: ProjectFormValues) => Promise<void>;
}

export function ProjectFormModal({
  open,
  mode,
  project,
  loading = false,
  error,
  onCancel,
  onSubmit,
}: ProjectFormModalProps) {
  const [form] = Form.useForm<ProjectFormValues>();

  useEffect(() => {
    if (!open) return;
    if (mode === "edit" && project) {
      form.setFieldsValue({
        name: project.name,
        discoveryUrl: project.discovery_url ?? "",
        prototypeUrl: project.prototype_url ?? "",
      });
    } else {
      form.resetFields();
    }
  }, [open, mode, project, form]);

  const isEdit = mode === "edit";

  return (
    <Modal
      title={isEdit ? "Editar projeto" : "Novo projeto"}
      open={open}
      onCancel={onCancel}
      footer={null}
      destroyOnHidden
      width={520}
    >
      <Paragraph type="secondary" style={{ marginBottom: 16 }}>
        {isEdit
          ? "Altere o nome ou as URLs do Figma. Se as URLs mudarem, o conteúdo será re-extraído."
          : "Informe a URL do Discovery (FigJam) e, opcionalmente, a do Protótipo (Figma)."}
      </Paragraph>

      {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}

      <Form
        form={form}
        layout="vertical"
        onFinish={onSubmit}
        requiredMark={false}
      >
        <Form.Item label="Nome do projeto" name="name">
          <Input placeholder="Nome exibido na plataforma" />
        </Form.Item>

        <Form.Item
          label="URL do Discovery (FigJam)"
          name="discoveryUrl"
          rules={[{ required: true, message: "Informe a URL do Discovery." }]}
        >
          <Input placeholder="https://www.figma.com/board/..." />
        </Form.Item>

        <Form.Item label="URL do Protótipo (Figma) — opcional" name="prototypeUrl">
          <Input placeholder="https://www.figma.com/design/..." />
        </Form.Item>

        <Flex justify="flex-end" gap={8}>
          <Button onClick={onCancel} disabled={loading}>
            Cancelar
          </Button>
          <Button type="primary" htmlType="submit" loading={loading}>
            {loading
              ? isEdit
                ? "Salvando..."
                : "Extraindo..."
              : isEdit
                ? "Salvar alterações"
                : "Criar projeto"}
          </Button>
        </Flex>
      </Form>
    </Modal>
  );
}
