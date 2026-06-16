import { Alert, Button, Card, Form, Input, Spin, Typography } from "antd";
import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ExtrakLogo } from "../components/ExtrakLogo";

const { Paragraph, Text } = Typography;

export function LoginPage() {
  const { session, loading, signIn } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (loading) {
    return (
      <div style={{ display: "grid", placeItems: "center", minHeight: "100vh" }}>
        <Spin size="large" />
      </div>
    );
  }

  if (session) {
    return <Navigate to="/" replace />;
  }

  async function handleSubmit(values: { email: string; password: string }) {
    setSubmitting(true);
    setError(null);
    try {
      await signIn(values.email, values.password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao entrar.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        background: "#fafafa",
      }}
    >
      <Card style={{ width: "100%", maxWidth: 420 }} bordered={false}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <ExtrakLogo variant="stacked" height={48} />
        </div>

        <Paragraph type="secondary" style={{ textAlign: "center", marginBottom: 24 }}>
          Entre com seu email e senha.
        </Paragraph>

        {error && (
          <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />
        )}

        <Form layout="vertical" onFinish={handleSubmit} requiredMark={false}>
          <Form.Item
            label="Email"
            name="email"
            rules={[
              { required: true, message: "Informe seu email." },
              { type: "email", message: "Email inválido." },
            ]}
          >
            <Input autoComplete="email" placeholder="voce@empresa.com" />
          </Form.Item>

          <Form.Item
            label="Senha"
            name="password"
            rules={[{ required: true, message: "Informe sua senha." }]}
          >
            <Input.Password autoComplete="current-password" />
          </Form.Item>

          <Form.Item style={{ marginBottom: 12 }}>
            <Button type="primary" htmlType="submit" block loading={submitting}>
              Entrar
            </Button>
          </Form.Item>
        </Form>

        <Text type="secondary" style={{ fontSize: 12, display: "block", textAlign: "center" }}>
          O acesso é criado por um administrador. Não há cadastro público.
        </Text>
      </Card>
    </div>
  );
}
