'use strict';
const config = {
  dataDir: '.',
  storage: 'tos',
  tos: {
    accessKeyId: 'fixture-id',
    accessKeySecret: 'fixture-secret',
    bucket: 'qianwan-test',
    region: 'cn-beijing',
    endpoint: 'tos-cn-beijing.volces.com',
    roleTrn: 'trn:iam::2000012345:role/uploader',
    publicOrigin: 'https://media.gynnai.com'
  }
};
const task = {
  id: '11111111-1111-4111-8111-111111111111',
  user_id: '22222222-2222-4222-8222-222222222222',
  kind: 'video',
  filename: 'fixture.mp4',
  size: 128,
  object_key:
    'private/22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-111111111111.mp4'
};
module.exports = { config, task };
