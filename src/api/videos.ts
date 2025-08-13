import { respondWithJSON } from "./json"

import { type BunRequest } from "bun"
import { randomBytes } from "crypto"
import path from "path"
import { getBearerToken, validateJWT } from "../auth"
import { type ApiConfig } from "../config"
import { getVideo, updateVideo } from "../db/videos"
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors"

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const MAX_UPLOAD_SIZE = 1 << 30 // 1GB

  const { videoId } = req.params as { videoId?: string }
  if (!videoId) {
    throw new BadRequestError("Invalid video ID")
  }

  const token = getBearerToken(req.headers)
  const userID = validateJWT(token, cfg.jwtSecret)

  console.log("uploading video", videoId, "by user", userID)


  const videoMetadata = getVideo(cfg.db, videoId)
  if (!videoMetadata) {
    throw new NotFoundError("Couldn't find video")
  }
  if (videoMetadata.userID !== userID) {
    throw new UserForbiddenError("Not authorized to upload a video")
  }


  const formData = await req.formData()
  const videoFormFile = formData.get("video")
  if (!(videoFormFile instanceof File)) {
    throw new BadRequestError("Invalid video file")
  }
  if (videoFormFile.size > MAX_UPLOAD_SIZE) {
    console.log(`Video file too large. Max size: ${MAX_UPLOAD_SIZE}, actual size: ${videoFormFile.size}`)
    throw new BadRequestError("Video file too large")
  }
  const mediaType = videoFormFile.type
  if (!(mediaType === "video/mp4")) {
    throw new BadRequestError("Invalid video file type")
  }
  const video = await videoFormFile.arrayBuffer()

  // write the video to a file
  const fileExtension = mediaType.split("/")[1]
  const fileName = `${randomBytes(32).toString("base64url")}.${fileExtension}`
  const videoFilePath = path.join(cfg.assetsRoot, fileName)
  await Bun.write(videoFilePath, video)

  // process the video
  const processedVideoFilePath = await processVideoForFastStart(videoFilePath)
  const videoFile = Bun.file(videoFilePath)
  await videoFile.delete()

  // upload the video to S3
  const processedVideoFile = Bun.file(processedVideoFilePath)
  const aspectRatio = await getVideoAspectRatio(processedVideoFilePath)
  const s3FilePath = `${aspectRatio}/${fileName}`
  console.log(`Uploading video to S3 at ${s3FilePath}`)
  const s3File = cfg.s3Client.file(s3FilePath)
  await s3File.write(processedVideoFile, {
    type: mediaType,
  })
  await processedVideoFile.delete()

  // update the video in the database
  videoMetadata.videoURL = `https://${cfg.s3CfDistribution}/${s3FilePath}`
  updateVideo(cfg.db, videoMetadata)


  console.log(`Video uploaded for video ${videoMetadata.title}`)
  return respondWithJSON(200, videoMetadata)
}


async function getVideoAspectRatio(filePath: string) {
  const process = Bun.spawn(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", filePath],
    {
      stdout: "pipe",
      stderr: "pipe",
    },)

  const outputText = await new Response(process.stdout).text()
  const errorText = await new Response(process.stderr).text()
  const exitCode = await process.exited

  if (exitCode !== 0) {
    throw new Error(`ffprobe error: ${errorText}`)
  }

  const json = JSON.parse(outputText)
  const width = json.streams[0].width
  const height = json.streams[0].height

  const ratio = width / height
  if (Math.abs(ratio - 16 / 9) < 0.05) {
    return "landscape"
  } else if (Math.abs(ratio - 9 / 16) < 0.05) {
    return "portrait"
  } else {
    return "other"
  }
}

async function processVideoForFastStart(inputFilePath: string) {
  const processedFilePath = `${inputFilePath}.processed`
  const process = Bun.spawn(["ffmpeg", "-i", inputFilePath, "-movflags", "faststart", "-codec", "copy", "-f", "mp4", processedFilePath],
    { stderr: "pipe" },)


  const errorText = await new Response(process.stderr).text()
  const exitCode = await process.exited

  if (exitCode !== 0) {
    throw new Error(`FFmpeg error: ${errorText}`)
  }

  return processedFilePath
}
