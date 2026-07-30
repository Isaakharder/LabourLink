import { useAuth } from "../../context/AuthContext";

interface PageHeaderProps {
  title: string;
  description?: string;
}

export function PageHeader({ title, description }: PageHeaderProps) {
  const { employee } = useAuth();

  return (
    <div className="page-header">
      <div className="page-header-text">
        <h1 className="page-header-title">{title}</h1>
        {description && <p className="page-header-description">{description}</p>}
      </div>
      {employee && (
        <span className="page-header-user">
          {employee.firstName} {employee.lastName}
        </span>
      )}
    </div>
  );
}
