/**
 * Test doubles for LibraryEligibilityService.
 *
 * Suites that test something OTHER than academic visibility (publication rules,
 * upload verification, thumbnails, purchase money flow) construct the Library
 * services with `openEligibility()`: storefront on, every material in scope,
 * no ownership exception. The academic rules themselves are exercised against
 * the real service in library-eligibility.spec.ts and
 * library-authorization.spec.ts.
 */
export function openEligibility(overrides: Record<string, unknown> = {}) {
  return {
    storefrontEnabled: true,
    scopeFor: jest.fn(async () => ({
      universityId: 'uni_1',
      facultyId: 'fac_1',
      departmentId: 'dep_1',
    })),
    materialWhere: jest.fn(() => ({})),
    isVisible: jest.fn(() => true),
    ownsAnyPartOf: jest.fn(async () => false),
    ...overrides,
  };
}

/** A CatalogService double for audience validation. */
export function catalogDouble(structure: { id: string; kind: 'YEAR' | 'LEVEL' } | null = {
  id: 'struct_1',
  kind: 'YEAR',
}) {
  return { resolveAcademicStructure: jest.fn(async () => structure) };
}
