import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { healthRouter } from './routes/health';
import { employeesRouter } from './routes/employees';

dotenv.config();

const app = express();
const PORT = process.env.PORT ?? 4000;

app.use(cors());
app.use(express.json());

app.use('/health', healthRouter);
app.use('/api/employees', employeesRouter);

app.listen(PORT, () => {
  console.log(`LabourLink API running on port ${PORT}`);
});
