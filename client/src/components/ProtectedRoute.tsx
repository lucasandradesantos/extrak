import { Spin, Typography } from "antd";
import type { ReactNode } from "react";
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
  const { session, profile, loading, isAdmin } = useAuth();

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
        <Text type="secondary">
          Seu usuário não tem um perfil configurado. Contate o administrador.
        </Text>
      </div>
    );
  }

  if (requireAdmin && !isAdmin) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}
