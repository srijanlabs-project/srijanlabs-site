import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

export function createStorage(env = process.env) {
  if (
    ![
      "S3_ENDPOINT",
      "S3_BUCKET",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
    ].every((k) => env[k])
  )
    return null;
  const client = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION || "auto",
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  const base = { Bucket: env.S3_BUCKET };
  return {
    async put(key, body, type = "application/json") {
      await client.send(
        new PutObjectCommand({
          ...base,
          Key: key,
          Body: body,
          ContentType: type,
        }),
      );
    },
    async get(key) {
      try {
        const result = await client.send(
          new GetObjectCommand({ ...base, Key: key }),
        );
        return Buffer.from(await result.Body.transformToByteArray());
      } catch (error) {
        if (
          error.name === "NoSuchKey" ||
          error.$metadata?.httpStatusCode === 404
        )
          return null;
        throw error;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ ...base, Key: key }));
    },
    async list(prefix) {
      const keys = [];
      let token;
      do {
        const result = await client.send(
          new ListObjectsV2Command({
            ...base,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        keys.push(...(result.Contents || []).map((item) => item.Key));
        token = result.NextContinuationToken;
      } while (token);
      return keys;
    },
  };
}
