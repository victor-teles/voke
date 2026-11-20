import { s3 } from "@vokejs/aws";

export const imageUploaded = s3({
  bucket: "uploadsBucket",
  handler: (event) => {
    console.info("uploaded", event.key, event.size);
  },
  prefix: "incoming/",
  suffix: ".jpg",
});
