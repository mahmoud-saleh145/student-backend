const noop = () => () => {};
for (const n of ['ApiTags','ApiOperation','ApiResponse','ApiBearerAuth','ApiProperty','ApiPropertyOptional','ApiExcludeEndpoint','ApiExcludeController','ApiQuery','ApiParam','ApiBody']) exports[n] = noop;
exports.PartialType = (B) => class extends B {};
