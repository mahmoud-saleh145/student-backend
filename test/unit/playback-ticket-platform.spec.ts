import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import {
  IssueTicketDto,
  PlaybackController,
} from 'src/modules/playback/playback.controller';

/**
 * Ticket-request contract.
 *
 * `platform` exists so the backend can hand an Apple client a FairPlay licence
 * instead of a Widevine one it cannot possibly use. It was declared, validated,
 * and then silently dropped on the floor - the symptom being an iPhone whose
 * DRM playback failed inside the CDM with no server-side explanation.
 *
 * These tests pin both halves of the fix: the field still validates to exactly
 * the three accepted values, and the controller actually forwards it.
 */

function buildController() {
  const playback = {
    issueTicket: jest.fn(async (_p: Record<string, unknown>) => ({ ticketId: 't_1' })),
  };

  const controller = new PlaybackController(playback as never);

  const req = {
    ip: '10.0.0.1',
    header: () => 'jest',
    deviceContext: { integritySuspect: false },
  } as never;

  const user = { id: 'stu_1', sessionId: 'sess_1', role: 'STUDENT' } as never;

  return { controller, playback, req, user };
}

describe('the platform field validates', () => {
  const check = (value: unknown) => {
    const dto = plainToInstance(IssueTicketDto, { platform: value }) as object;
    return validateSync(dto).map((e) => e.property);
  };

  it('accepts the three supported platforms', () => {
    for (const p of ['ios', 'android', 'web']) {
      expect(check(p)).toEqual([]);
    }
  });

  it('rejects anything else', () => {
    // An arbitrary string reaching the key-system selector would either be
    // ignored or, worse, be treated as truthy in a platform check.
    for (const p of ['macos', 'IOS', 'windows', 'android ', '']) {
      expect(check(p)).toContain('platform');
    }
  });

  it('is optional, so older clients that omit it keep working', () => {
    expect(check(undefined)).toEqual([]);
  });
});

describe('the controller forwards the platform', () => {
  it('passes ios through to the service', () => {
    const t = buildController();

    t.controller.issue('v1', { platform: 'ios' } as never, t.user, t.req);

    expect(t.playback.issueTicket).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'ios' }),
    );
  });

  it('passes android through', () => {
    const t = buildController();

    t.controller.issue('v1', { platform: 'android' } as never, t.user, t.req);

    expect(t.playback.issueTicket).toHaveBeenCalledWith(
      expect.objectContaining({ platform: 'android' }),
    );
  });

  it('passes an omitted platform as undefined, not a default guess', () => {
    const t = buildController();

    t.controller.issue('v1', {} as never, t.user, t.req);

    const arg = t.playback.issueTicket.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.platform).toBeUndefined();
  });

  it('still forwards the other request fields unchanged', () => {
    const t = buildController();

    t.controller.issue(
      'v1',
      { platform: 'ios', maxHeight: 480 } as never,
      t.user,
      t.req,
    );

    expect(t.playback.issueTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        videoId: 'v1',
        maxHeight: 480,
        platform: 'ios',
        ip: '10.0.0.1',
        integritySuspect: false,
      }),
    );
  });
});