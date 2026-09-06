import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE_KEY = 'rawResponse';

/** Opts a handler out of the success envelope (webhooks, file streams). */
export const RawResponse = () => SetMetadata(RAW_RESPONSE_KEY, true);
