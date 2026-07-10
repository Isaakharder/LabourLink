import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, KeyRound, Ban, CheckCircle2, LogOut, Plus } from 'lucide-react';
import { adminApi, type AdminUser } from '@/api/admin';
import { ApiError } from '@/lib/apiClient';
import { useAuth } from '@/lib/AuthContext';

const inputCls =
  'w-full px-3 py-2 text-sm border border-gray-200 rounded-md bg-white placeholder:text-gray-400 focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500';
const selectCls =
  'px-2 py-1 text-xs border border-gray-200 rounded-md bg-white focus:outline-none focus:ring-1 focus:ring-emerald-500 focus:border-emerald-500';

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function NewUserForm({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [roleId, setRoleId] = useState<number | ''>('');
  const [error, setError] = useState<string | null>(null);

  const { data: roles = [] } = useQuery({ queryKey: ['admin-roles'], queryFn: adminApi.listRoles });

  const mutation = useMutation({
    mutationFn: () => adminApi.createUser({ email, password, roleId: roleId as number }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Failed to create user'),
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        mutation.mutate();
      }}
      className="mb-4 space-y-3 rounded-md border border-gray-200 bg-gray-50 p-4"
    >
      {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Email</label>
          <input type="email" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Temporary password</label>
          <input type="password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} required />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600">Role</label>
          <select className={inputCls} value={roleId} onChange={(e) => setRoleId(Number(e.target.value))} required>
            <option value="">Select a role</option>
            {roles.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900">
          Cancel
        </button>
        <button
          type="submit"
          disabled={mutation.isPending}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {mutation.isPending ? 'Creating…' : 'Create user'}
        </button>
      </div>
    </form>
  );
}

function UserRow({ user }: { user: AdminUser }) {
  const queryClient = useQueryClient();
  const [showSessions, setShowSessions] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [newPassword, setNewPassword] = useState('');

  const { data: roles = [] } = useQuery({ queryKey: ['admin-roles'], queryFn: adminApi.listRoles });
  const { data: sessions = [] } = useQuery({
    queryKey: ['admin-user-sessions', user.id],
    queryFn: () => adminApi.listSessions(user.id),
    enabled: showSessions,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['admin-users'] });

  const toggleActive = useMutation({
    mutationFn: () => adminApi.updateUser(user.id, { isActive: !user.isActive }),
    onSuccess: invalidate,
  });

  const changeRole = useMutation({
    mutationFn: (roleId: number) => adminApi.updateUser(user.id, { roleId }),
    onSuccess: invalidate,
  });

  const resetPassword = useMutation({
    mutationFn: () => adminApi.resetPassword(user.id, newPassword),
    onSuccess: () => {
      setResetting(false);
      setNewPassword('');
    },
  });

  const revokeAll = useMutation({
    mutationFn: () => adminApi.revokeAllSessions(user.id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin-user-sessions', user.id] }),
  });

  return (
    <>
      <tr className="border-b border-gray-100">
        <td className="py-2.5 pr-4">
          <div className="font-medium text-gray-900">{user.email}</div>
          {user.employeeName && <div className="text-xs text-gray-400">Linked: {user.employeeName}</div>}
        </td>
        <td className="py-2.5 pr-4">
          <select
            className={selectCls}
            value={user.roleId}
            onChange={(e) => changeRole.mutate(Number(e.target.value))}
          >
            {roles.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </td>
        <td className="py-2.5 pr-4">
          {user.isActive ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
              <CheckCircle2 size={13} /> Active
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-400">
              <Ban size={13} /> Inactive
            </span>
          )}
          {user.lockedUntil && new Date(user.lockedUntil) > new Date() && (
            <div className="text-xs text-red-600">Locked until {formatDate(user.lockedUntil)}</div>
          )}
        </td>
        <td className="py-2.5 pr-4 text-xs text-gray-500">{formatDate(user.lastLoginAt)}</td>
        <td className="py-2.5 pr-4">
          <div className="flex items-center gap-3 text-xs">
            <button
              onClick={() => toggleActive.mutate()}
              className="text-gray-500 hover:text-gray-900"
              title={user.isActive ? 'Deactivate' : 'Activate'}
            >
              {user.isActive ? <Ban size={14} /> : <CheckCircle2 size={14} />}
            </button>
            <button onClick={() => setResetting((v) => !v)} className="text-gray-500 hover:text-gray-900" title="Reset password">
              <KeyRound size={14} />
            </button>
            <button onClick={() => setShowSessions((v) => !v)} className="text-gray-500 hover:text-gray-900" title="Sessions">
              <ShieldCheck size={14} />
            </button>
          </div>
        </td>
      </tr>
      {resetting && (
        <tr className="border-b border-gray-100 bg-gray-50">
          <td colSpan={5} className="px-2 py-2">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                resetPassword.mutate();
              }}
              className="flex items-center gap-2"
            >
              <input
                type="password"
                className={inputCls}
                placeholder="New password (min 10 characters)"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                minLength={10}
                required
              />
              <button type="submit" className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700">
                Set password
              </button>
              <button type="button" onClick={() => setResetting(false)} className="text-xs text-gray-500">
                Cancel
              </button>
            </form>
          </td>
        </tr>
      )}
      {showSessions && (
        <tr className="border-b border-gray-100 bg-gray-50">
          <td colSpan={5} className="px-2 py-2">
            {sessions.length === 0 ? (
              <p className="text-xs text-gray-400">No active sessions.</p>
            ) : (
              <div className="space-y-1">
                {sessions.map((s) => (
                  <div key={s.sid} className="flex items-center justify-between text-xs text-gray-500">
                    <span>
                      Last seen {formatDate(s.lastSeenAt)} · {s.userAgent ?? 'unknown device'}
                    </span>
                  </div>
                ))}
                <button
                  onClick={() => revokeAll.mutate()}
                  className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-red-600 hover:text-red-700"
                >
                  <LogOut size={13} /> Revoke all sessions
                </button>
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export function AdminUsersPage() {
  const [showNew, setShowNew] = useState(false);
  const { hasPermission } = useAuth();
  const { data: users = [], isLoading } = useQuery({
    queryKey: ['admin-users'],
    queryFn: adminApi.listUsers,
    enabled: hasPermission('users:manage'),
  });

  if (!hasPermission('users:manage')) {
    return (
      <div className="rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-500">
        You don't have permission to manage users.
      </div>
    );
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Users</h1>
          <p className="mt-1 text-sm text-gray-500">Manage login accounts, roles, and sessions for your company.</p>
        </div>
        {!showNew && (
          <button
            onClick={() => setShowNew(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
          >
            <Plus size={14} /> New user
          </button>
        )}
      </div>

      {showNew && <NewUserForm onClose={() => setShowNew(false)} />}

      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">
              <th className="px-4 py-2.5">Email</th>
              <th className="px-4 py-2.5">Role</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5">Last login</th>
              <th className="px-4 py-2.5">Actions</th>
            </tr>
          </thead>
          <tbody className="[&>tr>td]:px-4">
            {isLoading && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-sm text-gray-400">Loading…</td></tr>
            )}
            {!isLoading && users.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-sm text-gray-400">No users yet.</td></tr>
            )}
            {users.map((u) => <UserRow key={u.id} user={u} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}
