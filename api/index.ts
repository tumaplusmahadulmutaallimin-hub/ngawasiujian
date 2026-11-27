import 'dotenv/config';
import express from 'express';
import { createApiRouter } from '../server/routes.ts';

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true, limit: '12mb' }));

const apiRouter = createApiRouter();
app.use('/api', apiRouter);
app.use('/', apiRouter);

export default app;
