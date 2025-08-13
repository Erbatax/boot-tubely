import type { BunRequest } from "bun"
import { randomBytes } from "crypto"
import path from "path"
import { getBearerToken, validateJWT } from "../auth"
import type { ApiConfig } from "../config"
import { getVideo, updateVideo } from "../db/videos"
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors"
import { respondWithJSON } from "./json"

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const MAX_UPLOAD_SIZE = 10 << 20 // 10MB

  const { videoId } = req.params as { videoId?: string }
  if (!videoId) {
    throw new BadRequestError("Invalid video ID")
  }

  const token = getBearerToken(req.headers)
  const userID = validateJWT(token, cfg.jwtSecret)

  console.log("uploading thumbnail for video", videoId, "by user", userID)


  const videoMetadata = getVideo(cfg.db, videoId)
  if (!videoMetadata) {
    throw new NotFoundError("Couldn't find video")
  }
  if (videoMetadata.userID !== userID) {
    throw new UserForbiddenError("Not authorized to upload thumbnail for this video")
  }


  const formData = await req.formData()
  const thumbnailFile = formData.get("thumbnail")
  if (!(thumbnailFile instanceof File)) {
    throw new BadRequestError("Invalid thumbnail file")
  }
  if (thumbnailFile.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError("Thumbnail file too large")
  }
  const mediaType = thumbnailFile.type
  if (!(mediaType === "image/jpeg" || mediaType === "image/png")) {
    throw new BadRequestError("Invalid thumbnail file type")
  }

  const thumbnail = await thumbnailFile.arrayBuffer()

  const fileExtension = mediaType.split("/")[1]
  const fileName = `${randomBytes(32).toString("base64url")}.${fileExtension}`
  // write the thumbnail to a file
  const thumbnailFilePath = path.join(cfg.assetsRoot, fileName)
  await Bun.write(thumbnailFilePath, thumbnail)


  videoMetadata.thumbnailURL = `http://localhost:${cfg.port}/assets/${fileName}`
  updateVideo(cfg.db, videoMetadata)

  console.log(`Thumbnail uploaded for video ${videoMetadata.title}`)

  return respondWithJSON(200, videoMetadata)
}
