import { ReactNode } from "react";
import { useAuth } from "../../context/AuthContext";

interface PageHeaderProps {
  title: string;
  description?: string;
  // Optional content shown beside the title (Inputs' daily totals).
  titleAside?: ReactNode;
}

export function PageHeader({ title, description, titleAside }: PageHeaderProps) {
  const { employee } = useAuth();

  return (
    <div className="page-header">
      <div className="page-header-text">
        {titleAside ? (
          <div className="page-header-title-row">
            <h1 className="page-header-title">{title}</h1>
            {titleAside}
          </div>
        ) : (
          <h1 className="page-header-title">{title}</h1>
        )}
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
