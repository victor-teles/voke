import { s3 } from "@voke/aws";

export const imageUploaded = s3({
  bucket: "uploadsBucket",
  handler: (event) => {
    console.info("uploaded", event.key, event.size);
  },
  prefix: "incoming/",
  suffix: ".jpg",
});
