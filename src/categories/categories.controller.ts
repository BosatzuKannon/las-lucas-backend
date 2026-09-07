import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../modules/auth/jwt-auth.guard';
import { CategoriesService } from './categories.service';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  @Get('active')
  @UseGuards(JwtAuthGuard)
  getActive() {
    return this.categoriesService.getActive();
  }
}
