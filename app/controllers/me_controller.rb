# Who the app thinks you are. Handy for checking the Apache header wiring.
class MeController < InstructorController
  def show
    render json: { "eppn" => current_user.eppn, "name" => current_user.name, "role" => current_user.role }
  end
end
