// Never contacted by the signing tests; present so the module can load.
class Cmd { constructor(i){ this.input = i; } }
exports.GetObjectCommand = Cmd; exports.PutObjectCommand = Cmd;
exports.HeadObjectCommand = Cmd; exports.DeleteObjectCommand = Cmd;
exports.DeleteObjectsCommand = Cmd; exports.ListObjectsV2Command = Cmd;
exports.S3Client = class S3Client { constructor(c){ this.config = c; } async send(){ throw new Error('S3 not available in harness'); } };
