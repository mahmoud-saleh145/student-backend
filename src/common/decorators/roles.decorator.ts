import { SetMetadata } from '@nestjs/common';
import { UserRole } from '@prisma/client';

export const ROLES_KEY = 'roles';

/**
 * Restricts a route to the listed roles.
 *
 * MASTER is NOT implicitly granted — every route states its roles explicitly,
 * so a reader can tell from the decorator alone who can call it. Where master
 * should be allowed, list it.
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

/** Convenience: any back-office role. */
export const StaffOnly = () =>
  Roles(UserRole.MASTER, UserRole.ADMIN, UserRole.TEACHER);

/** Convenience: administrative roles (no teachers). */
export const AdminOnly = () => Roles(UserRole.MASTER, UserRole.ADMIN);

/** Convenience: the single master account. */
export const MasterOnly = () => Roles(UserRole.MASTER);

/** Convenience: students only. */
export const StudentOnly = () => Roles(UserRole.STUDENT);
