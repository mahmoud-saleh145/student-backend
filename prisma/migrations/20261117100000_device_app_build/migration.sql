-- The native build number a device signed in with (the `X-App-Build` header:
-- Android versionCode, iOS build number).
--
-- Every build of the mobile app reports the same app VERSION, so the version
-- cannot tell an install that plays the mobile HLS stream from an older one.
-- The build can. It is used for one decision: who is told about a lecture that
-- is playable only in the app (see new-video-announcer.service.ts).
--
-- Additive: one nullable column, no default, no index, no existing row
-- touched. It fills in as devices sign in; NULL means "not reported yet".
ALTER TABLE "devices"
  ADD COLUMN "appBuild" TEXT;
