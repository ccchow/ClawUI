import express from "express";
import cors from "cors";
import router from "./routes.js";

const PORT = parseInt(process.env.PORT || "3001", 10);

const app = express();

app.use(cors());
app.use(express.json());
app.use(router);

app.listen(PORT, () => {
  console.log(`ClawUI backend running on http://localhost:${PORT}`);
});
