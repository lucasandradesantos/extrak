import { Button, Space, Spin, Typography } from "antd";
import { useState, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

const { Text } = Typography;

export function ProtectedRoute({
  children,
  requireAdmin = false,
}: {
  children: ReactNode;
  requireAdmin?: boolean;
}) {
  const { session, profile, loading, isAdmin, reloadProfile, signOut } = useAuth();
  const [retrying, setRetrying] = useState(false);

  if (loading) {
    return (
      <div style={{ display: "grid", placeItems: "center", minHeight: "60vh" }}>
        <Spin size="large" tip="Carregando..." />
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/login" replace />;
  }

  if (!profile) {
    return (
      <div style={{ display: "grid", placeItems: "center", minHeight: "60vh", padding: 24 }}>
        <Space direction="vertical" align="center" size={16}>
          <Text type="secondary" style={{ textAlign: "center" }}>
            Não foi possível carregar seu perfil. Pode ser uma falha de conexão
            temporária — tente novamente. Se persistir, contate o administrador.
          </Text>
          <Space>
            <Button
              type="primary"
              loading={retrying}
              onClick={async () => {
                setRetrying(true);
                try {
                  await reloadProfile();
                } finally {
                  setRetrying(false);
                }
              }}
            >
              Tentar novamente
            </Button>
            <Button onClick={() => signOut()}>Sair</Button>
          </Space>
        </Space>
      </div>
    );
  }

  if (requireAdmin && !isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
