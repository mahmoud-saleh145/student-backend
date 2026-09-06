// Minimal @nestjs/common stub: just enough for the pure services to load.
const noopDecorator = () => () => {};
exports.Injectable = () => (target) => target;
exports.Inject = noopDecorator;
exports.Global = () => (t) => t;
exports.Module = () => (t) => t;
exports.Controller = () => (t) => t;
for (const v of ['Get','Post','Put','Patch','Delete','Body','Param','Query','Req','Res','Headers','HttpCode','SetMetadata','UseGuards','UseInterceptors']) {
  exports[v] = noopDecorator;
}
exports.Logger = class Logger {
  constructor(ctx){ this.ctx = ctx; }
  log(){} warn(){} error(){} debug(){} verbose(){}
};
exports.HttpStatus = { OK:200, CREATED:201, BAD_REQUEST:400, UNAUTHORIZED:401,
  PAYMENT_REQUIRED:402, FORBIDDEN:403, NOT_FOUND:404, CONFLICT:409, GONE:410,
  UNPROCESSABLE_ENTITY:422, TOO_MANY_REQUESTS:429, INTERNAL_SERVER_ERROR:500,
  SERVICE_UNAVAILABLE:503 };
class HttpException extends Error {
  constructor(response, status){
    super(typeof response === 'string' ? response : (response && response.message) || 'Error');
    this.response = response; this.status = status;
  }
  getStatus(){ return this.status; }
  getResponse(){ return this.response; }
}
exports.HttpException = HttpException;
exports.applyDecorators = (...d) => (...a) => d.forEach((x) => x && x(...a));
