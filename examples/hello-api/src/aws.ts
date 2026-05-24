import { bindResource, createAwsClientConfig } from "voke/aws";

export const usersTable = bindResource("usersTable", "name");
export const eventsQueue = bindResource("eventsQueue", "url");

export const createExampleAwsClientConfig = () => createAwsClientConfig();
