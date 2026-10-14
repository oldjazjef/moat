import { Controller, Get, Header } from '@nestjs/common';
import { RECIPE_IDS, RECIPES, type Recipe } from '@moat/core';

/**
 * The recipes (FR-43) as the wizard offers them: what each one adds to moat.yaml and the test
 * body «Testen» proposes. Static data from the core; the web app does not import the core.
 */
@Controller('recipes')
export class RecipesController {
  @Get()
  @Header('Cache-Control', 'no-store')
  list(): readonly Recipe[] {
    return RECIPE_IDS.map((id) => RECIPES[id]);
  }
}
