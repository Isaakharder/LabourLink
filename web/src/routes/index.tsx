import { createBrowserRouter } from 'react-router-dom';
import { Layout } from '@/components/layout/Layout';
import { DashboardPage } from '@/pages/DashboardPage';
import { EmployeesPage } from '@/pages/employees/EmployeesPage';
import { ContractsPage } from '@/pages/contracts/ContractsPage';
import { ActivitiesPage } from '@/pages/activities/ActivitiesPage';
import { CropsPage } from '@/pages/crops/CropsPage';
import { VarietiesPage } from '@/pages/varieties/VarietiesPage';
import { LocationGroupsPage } from '@/pages/location-groups/LocationGroupsPage';
import { LocationsPage } from '@/pages/locations/LocationsPage';
import { SitesPage } from '@/pages/sites/SitesPage';
import { CarriersPage } from '@/pages/carriers/CarriersPage';
import { TeamsPage } from '@/pages/teams/TeamsPage';
import { InputPage } from '@/pages/InputPage';
import { ReportsPage } from '@/pages/ReportsPage';
import { ConfigurationPage } from '@/pages/ConfigurationPage';
import { ViewGreenhousePage } from '@/pages/greenhouse/ViewGreenhousePage';
import { GreenhouseMapBuilderPage } from '@/pages/greenhouse/GreenhouseMapBuilderPage';
import { AdminUsersPage } from '@/pages/admin/AdminUsersPage';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <Layout />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'employees', element: <EmployeesPage /> },
      { path: 'contracts', element: <ContractsPage /> },
      { path: 'activities', element: <ActivitiesPage /> },
      { path: 'crops', element: <CropsPage /> },
      { path: 'varieties', element: <VarietiesPage /> },
      { path: 'location-groups', element: <LocationGroupsPage /> },
      { path: 'locations', element: <LocationsPage /> },
      { path: 'sites', element: <SitesPage /> },
      { path: 'carriers', element: <CarriersPage /> },
      { path: 'teams', element: <TeamsPage /> },
      { path: 'input', element: <InputPage /> },
      { path: 'reports', element: <ReportsPage /> },
      { path: 'configuration', element: <ConfigurationPage /> },
      { path: 'greenhouse', element: <ViewGreenhousePage /> },
      { path: 'greenhouse/builder/:mapId', element: <GreenhouseMapBuilderPage /> },
      { path: 'admin/users', element: <AdminUsersPage /> },
    ],
  },
]);
