import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { StaffOnly } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { MAX_SOURCE_BYTES, VideosService } from './videos.service';
import { GumletIngestService } from './gumlet-ingest.service';
import { DrmVerificationService } from '../playback/drm-verification.service';
import { LessonVideoService } from './lesson-video.service';

class InitUploadDto {
  @IsString() @MaxLength(32) lessonId!: string;

  @IsString()
  @MaxLength(255)
  @Matches(/^[\w .()\-؀-ۿ]+\.[A-Za-z0-9]{2,5}$/, {
    message: 'filename contains unsupported characters',
  })
  filename!: string;

  @IsString() @MaxLength(100) contentType!: string;

  @Type(() => Number) @IsInt() @Min(1) @Max(MAX_SOURCE_BYTES) sizeBytes!: number;
}

class AttachExistingVideoDto {
  @IsString() @MaxLength(32) videoId!: string;
}

class RemoveVideoQueryDto {
  /** The lecture the video is being removed from. Required for a shared asset. */
  @IsOptional() @IsString() @MaxLength(32) lessonId?: string;
}

/**
 * What the client claims it sent.
 *
 * OPTIONAL ON PURPOSE. A client that never got an answer does not know
 * whether the bytes landed, and this endpoint is exactly how it finds out -
 * so the endpoint has to be callable without the claim.
 *
 * When the claim IS present it is checked against the object actually stored:
 * a truncated upload is refused rather than processed into a lecture that ends
 * mid-sentence.
 */
class CompleteUploadDto {
  /** How many bytes the client sent. Checked against the stored object. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(MAX_SOURCE_BYTES)
  sizeBytes?: number;
}

class AddCaptionDto {
  @IsIn(['en', 'ar']) language!: string;
  @IsString() @MaxLength(80) label!: string;
  @IsString() @MaxLength(400) objectKey!: string;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

/**
 * Video upload and processing.
 *
 * Note what is absent: there is no endpoint here that returns a playable URL.
 * Delivery is exclusively through POST /playback/videos/{id}/ticket.
 */
@ApiTags('videos')
@ApiBearerAuth('access-token')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videos: VideosService,
    private readonly gumletIngest: GumletIngestService,
    private readonly drmVerification: DrmVerificationService,
    private readonly lessonVideos: LessonVideoService,
  ) {}

  @Post('uploads/init')
  @StaffOnly()
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      'Returns a presigned PUT to the private uploads bucket. Bytes go client→R2 directly; this API never proxies the file.',
  })
  init(@Body() dto: InitUploadDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.videos.initUpload(dto, actor);
  }

  @Post(':videoId/complete')
  @StaffOnly()
  @ApiOperation({
    summary: 'Confirm the upload and queue transcoding',
    description: [
      'Verifies the object actually landed in storage before enqueueing, so the queue does not fill with jobs that fail minutes later.',
      '',
      'Idempotent and recoverable. Calling it again on a video that is already queued returns the',
      'current state instead of enqueuing a second job, and calling it on a video whose upload was',
      'interrupted - including one whose bytes reached storage but whose acknowledgement did not -',
      'completes the upload without the file being sent again.',
      '',
      'Optional body: { sizeBytes }. When present it is compared with the stored object, so a',
      'truncated upload is refused rather than processed.',
    ].join('\n'),
  })
  complete(
    @Param('videoId') videoId: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Body() dto: CompleteUploadDto,
  ) {
    return this.videos.completeUpload(videoId, actor, dto?.sizeBytes ?? null);
  }

  @Get(':videoId/status')
  @StaffOnly()
  @ApiOperation({
    summary: 'Processing status and generated renditions',
    description: 'Poll this while status is QUEUED or PROCESSING.',
  })
  status(@Param('videoId') videoId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.videos.status(videoId, actor);
  }

  @Post(':videoId/retry')
  @StaffOnly()
  @ApiOperation({ summary: 'Re-run transcoding from the stored source' })
  retry(@Param('videoId') videoId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.videos.retryProcessing(videoId, actor);
  }

  @Post(':videoId/captions')
  @StaffOnly()
  @ApiOperation({
    summary: 'Attach a caption track',
    description: 'Takes an object key from POST /storage/uploads/attachment.',
  })
  addCaption(
    @Param('videoId') videoId: string,
    @Body() dto: AddCaptionDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.videos.addCaption(videoId, dto, actor);
  }

  @Delete(':videoId/captions/:language')
  @StaffOnly()
  @ApiOperation({ summary: 'Remove a caption track' })
  removeCaption(
    @Param('videoId') videoId: string,
    @Param('language') language: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.videos.removeCaption(videoId, language, actor);
  }

  @Delete(':videoId')
  @StaffOnly()
  @ApiOperation({
    summary: 'Remove a video from a lecture; archive it when no other lecture uses it',
    description:
      'Pass ?lessonId= to name the lecture it is being removed from; required when the asset is attached to more than one lecture. ' +
      'While other lectures still use the asset it is only detached from that lecture. Otherwise the metadata row is archived ' +
      '(retained because watch events reference it) and the HLS output and source file are deleted from storage.',
  })
  remove(
    @Param('videoId') videoId: string,
    @Query() query: RemoveVideoQueryDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.videos.remove(videoId, actor, true, query.lessonId);
  }

  // ---------------------------------------------------------------------------
  // Gumlet-backed delivery (opt-in per video)
  // ---------------------------------------------------------------------------

  @Post(':videoId/gumlet/adopt')
  @StaffOnly()
  @ApiOperation({
    summary: 'Hand this video to Gumlet for DRM packaging and delivery',
    description: [
      'Idempotent: re-calling refreshes an existing asset rather than creating',
      'a duplicate. Sets the video to PROCESSING; it becomes PLAYABLE only once',
      'Gumlet reports the asset ready AND the manifest is confirmed',
      'CENC-encrypted.',
    ].join('\n'),
  })
  async gumletAdopt(@Param('videoId') videoId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.assertCanManageVideo(videoId, actor);
    return this.gumletIngest.adopt(videoId);
  }

  @Post(':videoId/gumlet/sync')
  @StaffOnly()
  @ApiOperation({
    summary: 'Re-check a Gumlet asset and mirror its state',
    description:
      'Polls Gumlet and updates status. Blocks playback if Gumlet reports ready but the manifest is not encrypted.',
  })
  async gumletSync(@Param('videoId') videoId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.assertCanManageVideo(videoId, actor);
    return this.gumletIngest.sync(videoId);
  }

  @Get(':videoId/gumlet/status')
  @StaffOnly()
  @ApiOperation({ summary: 'Gumlet provisioning state for a video' })
  async gumletStatus(@Param('videoId') videoId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.assertCanManageVideo(videoId, actor);
    return this.gumletIngest.status(videoId);
  }

  /**
   * Re-verify DRM against the live provider.
   *
   * This is a VERIFICATION, not an override. It reads Gumlet and the manifest and
   * records what it finds. There is deliberately no "mark as protected" path: an
   * admin action must never be able to grant playback that the backend has not
   * actually verified against the provider.
   */
  @Post(':videoId/gumlet/verify')
  @StaffOnly()
  @ApiOperation({
    summary: 'Re-check that this video is verifiably DRM-protected',
    description:
      'Reads the asset state from Gumlet and confirms the DASH manifest is CENC-encrypted. ' +
      'Only this endpoint can set drmVerifiedAt.',
  })
  async gumletVerify(@Param('videoId') videoId: string, @CurrentUser() actor: AuthenticatedUser) {
    await this.assertCanManageVideo(videoId, actor);
    return this.drmVerification.verify(videoId);
  }

  /**
   * Repair a TERMINALLY FAILED Gumlet asset by creating a fresh one from the
   * same stored source.
   *
   * WHY THIS ENDPOINT HAS TO EXIST
   *
   * `adopt()` is deliberately idempotent: once a row carries a
   * `gumletAssetId`, it re-syncs that asset rather than creating a second one.
   * That is what stops a re-run producing duplicate, double-billed assets - and
   * it is also why a video whose asset died at the provider could never be
   * recovered. `POST /videos/:id/retry` and `POST /videos/:id/gumlet/sync` both
   * re-read the same dead asset and return the same terminal verdict, forever.
   * `replaceFailedAsset()` was written to break that deadlock by discarding the
   * dead id and ingesting a fresh one, but it was only reachable from the
   * migration CLI, so the operational path out of a failed asset did not exist.
   *
   * IT IS DELIBERATELY NARROW. It does NOT delete the video, the R2 source, the
   * lesson relationships or the failed Gumlet asset; it does NOT touch any other
   * video; it refuses a `processing` or `ready` asset; it is atomic against
   * concurrent attempts; and it still requires the caller to have write access
   * to the video's course. There is no bulk or "repair everything" route.
   */
  @Post(':videoId/gumlet/replace-failed-asset')
  @StaffOnly()
  @ApiOperation({
    summary: 'Replace a terminally failed Gumlet asset with a freshly ingested one',
    description: [
      'For an asset Gumlet reports as `errored`/`failed`. Creates a new asset from the',
      'SAME stored R2 source with a fresh presigned URL, and keeps the old asset id',
      'recorded in the audit trail and on the row. Refuses a `processing` or `ready`',
      'asset. Sets the video to PROCESSING; it becomes PLAYABLE only once Gumlet reports',
      'the new asset ready AND the manifest is confirmed CENC-encrypted.',
    ].join('\n'),
  })
  async gumletReplaceFailedAsset(
    @Param('videoId') videoId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    await this.assertCanManageVideo(videoId, actor);
    return this.gumletIngest.replaceFailedAsset(videoId, {
      // This endpoint exists ONLY to repair a video already routed through
      // Gumlet, so the deliberate-opt-in that `replaceFailedAsset` requires for
      // that case is passed explicitly here. The terminal-failure guard, which
      // is the actual protection against destroying a live asset, still applies
      // in full - see gumlet-ingest.service.ts.
      allowGumletProviderReplacement: true,
      // Recorded on the audit row, so the replacement is attributable rather
      // than an anonymous mutation of an asset reference.
      actor: { id: actor.id, role: actor.role },
    });
  }

  /**
   * Staff can reach these endpoints, but only for content they are allowed to
   * manage. Without this, any staff account could ingest or inspect a video
   * belonging to a course outside their scope - which is exactly the ownership
   * check every other write on `videos` already performs.
   */
  /**
   * Attach an ALREADY UPLOADED video to a lecture.
   *
   * This is the reuse endpoint. It never uploads bytes, never creates a Gumlet
   * asset and never enqueues processing: it points the destination lecture at
   * the existing asset, which keeps its duration, its DRM verification and its
   * playback tickets exactly as they are.
   *
   * Authorisation is checked against the DESTINATION course, not the video's
   * source course. Sharing an asset into a course must require permission on
   * that course, otherwise any teacher could push material into a course they
   * do not own by attaching a video they happen to manage.
   *
   * Note the deliberate absence of any playback URL here: attaching does not
   * grant access. A student still needs entitlement to the destination lecture,
   * which is enforced in PlaybackService when the ticket is minted.
   */
  @Post('reuse/:lessonId')
  @StaffOnly()
  @ApiOperation({
    summary: 'Attach an existing uploaded video to a lecture',
    description:
      'References the existing video and Gumlet asset. No re-upload, no new asset, ' +
      'no processing. Idempotent: re-applying the same mapping returns created=false.',
  })
  async attachExisting(
    @Param('lessonId') lessonId: string,
    @Body() dto: AttachExistingVideoDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    // Both courses are gates. The destination check stops staff writing into a
    // course they do not manage; the source check stops staff copying another
    // course's paid media into a course whose enrolment and pricing they control.
    const lesson = await this.videos.getCourseForLesson(lessonId);
    if (!lesson) throw new NotFoundException('Lesson not found');
    await this.videos.assertCanManageCourseContent(actor.id, actor.role, lesson.courseId);
    await this.assertCanManageVideo(dto.videoId, actor);

    return this.lessonVideos.attach({ lessonId, videoId: dto.videoId, actorId: actor.id });
  }

  /**
   * Remove one lecture's attachment.
   *
   * Detaching never destroys the shared asset while another lecture still uses
   * it, and never revokes other courses' live playback grants. Removing the
   * asset entirely remains an explicit, separately-authorised decision.
   */
  @Delete('reuse/:lessonId/:videoId')
  @StaffOnly()
  @ApiOperation({
    summary: 'Detach a video from one lecture without destroying the asset',
  })
  async detachExisting(
    @Param('lessonId') lessonId: string,
    @Param('videoId') videoId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    // Authorised against the lecture's own course inside VideosService.detach,
    // which also revokes that lecture's live tickets, releases the origin
    // pointer when the uploading lecture is detached, resets its duration and
    // recounts its course - none of which the bare row delete did.
    return this.videos.detach(videoId, lessonId, actor);
  }

  private async assertCanManageVideo(videoId: string, actor: AuthenticatedUser): Promise<void> {
    const video = await this.videos.getCourseForVideo(videoId);
    if (!video) throw new NotFoundException('Video not found');
    await this.videos.assertCanManageCourseContent(actor.id, actor.role, video.courseId);
  }
}
