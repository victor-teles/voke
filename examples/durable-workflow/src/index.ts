import { voke } from "voke";

import config from "../voke.config";
import { functions } from "./functions";

export default voke(functions, { config });
