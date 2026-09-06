import { SetMetadata } from '@nestjs/common';
import type { AuditAction } from '@prisma/client';

export const AUDIT_KEY = 'audit';

export interface AuditMetadata {
  action: AuditAction;
  entity: string;
  /** Route param holding the entity id, e.g. 'id' or 'courseId'. */
  idParam?: string;
}

/**
 * Marks a mutation for the audit trail. The interceptor writes the row after
 * the handler succeeds, so a failed operation is not recorded as if it had
 * happened.
 */
export const Audit = (metadata: AuditMetadata) => SetMetadata(AUDIT_KEY, metadata);
