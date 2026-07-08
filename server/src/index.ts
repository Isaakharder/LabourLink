import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { healthRouter } from './routes/health';
import { employeesRouter } from './routes/employees';
import { activitiesRouter } from './routes/activities';
import { locationsRouter } from './routes/locations';
import { workRouter } from './routes/work';
import { contractsRouter } from './routes/contracts';
import { locationGroupsRouter } from './routes/location-groups';
import { greenhouseMapsRouter } from './routes/greenhouse-maps';
import { cropsRouter } from './routes/crops';
import { varietiesRouter } from './routes/varieties';

dotenv.config();

const app = express();
const PORT = process.env.PORT ?? 4000;

app.use(cors());
app.use(express.json());

app.use('/health', healthRouter);
app.use('/api/employees', employeesRouter);
app.use('/api/activities', activitiesRouter);
app.use('/api/locations', locationsRouter);
app.use('/api/location-groups', locationGroupsRouter);
app.use('/api/work', workRouter);
app.use('/api/contracts', contractsRouter);
app.use('/api/greenhouse-maps', greenhouseMapsRouter);
app.use('/api/crops', cropsRouter);
app.use('/api/varieties', varietiesRouter);

app.listen(PORT, () => {
  if (process.env.NODE_ENV !== 'production') {
    console.log(`LabourLink API running on port ${PORT}`);
  }
});
