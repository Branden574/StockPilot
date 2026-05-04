import { redirect } from 'next/navigation';

/**
 * The Team page already provides full user / invite management. Admin
 * link goes through it for now; future: split into a richer admin-only
 * view with charter + warehouse filters and bulk actions.
 */
export default function AdminUsersPage(): never {
  redirect('/dashboard/team');
}
