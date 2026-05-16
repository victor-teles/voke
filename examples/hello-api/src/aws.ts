import { bindResource, createAwsClientConfig } from "voke";

export const usersTable = bindResource("usersTable", "name");
export const eventsQueue = bindResource("eventsQueue", "url");

export const createExampleAwsClientConfig = () => createAwsClientConfig();
